export function runtimeShim(documentPath: string, storage: Record<string, string>): string {
  return `<script>
    (() => {
      const reportDocumentPath = ${JSON.stringify(documentPath)};
      const initialStorage = ${JSON.stringify(storage)};
      const parentWindow = window.parent;
      const nativeFetch = window.fetch.bind(window);
      const pendingResources = new Map();
      let nextRequestId = 0;

      class MemoryStorage {
        #values;
        constructor(values, persist) {
          this.#values = new Map(Object.entries(values));
          this.persist = persist;
        }
        get length() { return this.#values.size; }
        clear() { this.#values.clear(); }
        getItem(key) { return this.#values.get(String(key)) ?? null; }
        key(index) { return [...this.#values.keys()][index] ?? null; }
        removeItem(key) { this.#values.delete(String(key)); }
        setItem(key, value) {
          const stringKey = String(key);
          const stringValue = String(value);
          this.#values.set(stringKey, stringValue);
          if (this.persist) parentWindow.postMessage({ type: 'storage-write', key: stringKey, value: stringValue }, '*');
        }
      }

      const local = new MemoryStorage(initialStorage, true);
      const session = new MemoryStorage({}, false);
      Object.defineProperties(window, {
        localStorage: { configurable: true, value: local },
        sessionStorage: { configurable: true, value: session },
      });

      function isLocal(reference) {
        return typeof reference === 'string' && !/^(?:[a-z][a-z\\d+.-]*:|#)/iu.test(reference);
      }

      function resourceUrl(reference) {
        if (!isLocal(reference)) return Promise.resolve(reference);
        const id = String(nextRequestId++);
        const promise = new Promise((resolve, reject) => pendingResources.set(id, { resolve, reject }));
        parentWindow.postMessage({ type: 'resource-request', id, documentPath: reportDocumentPath, reference }, '*');
        return promise;
      }

      window.fetch = async (input, init) => {
        const reference = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return nativeFetch(await resourceUrl(reference), init);
      };

      async function resourceBlobUrl(blob) {
        if (blob.type !== 'text/css') return URL.createObjectURL(blob);
        const css = await blob.text();
        const rewritten = await rewriteCss(css);
        return URL.createObjectURL(new Blob([rewritten], { type: blob.type }));
      }

      async function rewriteCss(css) {
        const pattern = /url\\(\\s*(['"]?)(.*?)\\1\\s*\\)/giu;
        const matches = [...css.matchAll(pattern)];
        const urls = await Promise.all(matches.map(async (match) => [match[0], await resourceUrl(match[2]) ]));
        for (const [source, url] of urls) css = css.replace(source, 'url("' + url + '")');
        return css;
      }

      const nativeXhrOpen = XMLHttpRequest.prototype.open;
      const nativeXhrSend = XMLHttpRequest.prototype.send;
      const pendingXhr = new WeakMap();
      XMLHttpRequest.prototype.open = function(method, url, async = true, user, password) {
        const reference = url instanceof URL ? url.href : String(url);
        if (!isLocal(reference)) return nativeXhrOpen.call(this, method, url, async, user, password);
        if (!async) throw new DOMException('Synchronous report XHR is not supported', 'NotSupportedError');
        pendingXhr.set(this, { method, reference, user, password });
      };
      XMLHttpRequest.prototype.send = function(body) {
        const request = pendingXhr.get(this);
        if (!request) return nativeXhrSend.call(this, body);
        pendingXhr.delete(this);
        resourceUrl(request.reference).then((url) => {
          nativeXhrOpen.call(this, request.method, url, true, request.user, request.password);
          nativeXhrSend.call(this, body);
        }).catch(() => {
          this.dispatchEvent(new ProgressEvent('error'));
          this.dispatchEvent(new ProgressEvent('loadend'));
        });
      };

      const rewriteSrcset = (element) => {
        const value = element.getAttribute('srcset');
        if (!value) return;
        Promise.all(value.split(',').map((candidate) => {
          const [reference, ...descriptor] = candidate.trim().split(/\\s+/u);
          return isLocal(reference) ? resourceUrl(reference).then((url) => [url, ...descriptor].join(' ')) : candidate.trim();
        })).then((candidates) => {
          const rewritten = candidates.join(', ');
          if (element.getAttribute('srcset') !== rewritten) element.setAttribute('srcset', rewritten);
        }).catch(() => console.warn('Missing report resource:', value));
      };
      const rewriteElement = (element, attribute) => {
        if (attribute === 'srcset') return rewriteSrcset(element);
        if (attribute === 'href' && element.tagName !== 'LINK') return;
        const reference = element.getAttribute(attribute);
        if (!isLocal(reference)) return;
        resourceUrl(reference).then((url) => element.setAttribute(attribute, url)).catch(() => console.warn('Missing report resource:', reference));
      };
      const activateDeferredResource = (element) => {
        const reference = element.dataset.reportReference;
        if (reference) resourceUrl(reference).then((url) => {
          const attribute = element.hasAttribute('href') ? 'href' : element.hasAttribute('data') ? 'data' : 'src';
          element.setAttribute(attribute, url);
          delete element.dataset.reportReference;
        }).catch(() => console.warn('Missing report resource:', reference));
        const srcset = element.dataset.reportSrcset;
        if (srcset) {
          Promise.all(srcset.split(',').map((candidate) => {
            const [reference, ...descriptor] = candidate.trim().split(/\\s+/u);
            return resourceUrl(reference).then((url) => [url, ...descriptor].join(' '));
          })).then((candidates) => {
            element.setAttribute('srcset', candidates.join(', '));
            delete element.dataset.reportSrcset;
          }).catch(() => console.warn('Missing report resource:', srcset));
        }
      };
      const rewriteNode = (node) => {
        if (!(node instanceof Element)) return;
        for (const element of [node, ...node.querySelectorAll('[src], [href], [poster], [srcset]')]) {
          activateDeferredResource(element);
          for (const attribute of ['src', 'href', 'poster', 'srcset']) {
            if (element.hasAttribute(attribute)) rewriteElement(element, attribute);
          }
        }
      };
      new MutationObserver((changes) => {
        for (const change of changes) {
          if (change.type === 'attributes') rewriteElement(change.target, change.attributeName);
          if (change.type === 'childList') change.addedNodes.forEach(rewriteNode);
        }
      }).observe(document, { attributes: true, attributeFilter: ['href', 'poster', 'src', 'srcset'], childList: true, subtree: true });
      document.querySelectorAll('[data-report-reference], [data-report-srcset]').forEach(activateDeferredResource);

      const nativeOpen = window.open.bind(window);
      window.open = (url, target, features) => {
        if (typeof url !== 'string' || !isLocal(url)) return nativeOpen(url, target, features);
        const popup = nativeOpen('about:blank', target, features);
        resourceUrl(url).then((resource) => {
          if (popup) popup.location.replace(resource);
          else nativeOpen(resource, target, features);
        }).catch(() => console.warn('Missing report resource:', url));
        return popup;
      };

      document.addEventListener('click', (event) => {
        const anchor = event.target.closest('a[data-report-path]');
        if (anchor) {
          event.preventDefault();
          parentWindow.postMessage({ type: 'navigate', path: anchor.dataset.reportPath }, '*');
        }
      });

      window.addEventListener('message', (event) => {
        if (event.source !== parentWindow || event.data?.type !== 'resource-response') return;
        const pending = pendingResources.get(event.data.id);
        if (!pending) return;
        pendingResources.delete(event.data.id);
        event.data.blob instanceof Blob ? resourceBlobUrl(event.data.blob).then(pending.resolve, pending.reject) : pending.reject(new Error(event.data.error || 'Missing report resource'));
      });
    })();
  </script>`;
}