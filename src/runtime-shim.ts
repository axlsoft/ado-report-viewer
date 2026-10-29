export function runtimeShim(documentPath: string): string {
  return `<script>
    (() => {
      const reportDocumentPath = ${JSON.stringify(documentPath)};
      const parentWindow = window.parent;
      const nativeFetch = window.fetch.bind(window);
      const pendingResources = new Map();
      let nextRequestId = 0;

      class MemoryStorage {
        #values = new Map();
        get length() { return this.#values.size; }
        clear() { this.#values.clear(); }
        getItem(key) { return this.#values.get(String(key)) ?? null; }
        key(index) { return [...this.#values.keys()][index] ?? null; }
        removeItem(key) { this.#values.delete(String(key)); }
        setItem(key, value) {
          const stringKey = String(key);
          const stringValue = String(value);
          this.#values.set(stringKey, stringValue);
          parentWindow.postMessage({ type: 'storage-write', key: stringKey, value: stringValue }, '*');
        }
      }

      const local = new MemoryStorage();
      const session = new MemoryStorage();
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

      const rewriteElement = (element, attribute) => {
        const reference = element.getAttribute(attribute);
        if (!isLocal(reference)) return;
        resourceUrl(reference).then((url) => element.setAttribute(attribute, url)).catch(() => console.warn('Missing report resource:', reference));
      };
      new MutationObserver((changes) => {
        for (const change of changes) {
          if (change.type === 'attributes') rewriteElement(change.target, change.attributeName);
        }
      }).observe(document, { attributes: true, attributeFilter: ['href', 'poster', 'src'], childList: true, subtree: true });

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
        event.data.url ? pending.resolve(event.data.url) : pending.reject(new Error(event.data.error || 'Missing report resource'));
      });
    })();
  <\\/script>`;
}