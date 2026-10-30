export interface RuntimeConfig {
  documentPath: string;
  storage: Record<string, string>;
}

/** Returns the `<script>` injected as the first element of every report document. */
export function runtimeShim(documentPath: string, storage: Record<string, string>): string {
  const code = installReportRuntime.toString();
  if (/<\/script|<!--/iu.test(code)) {
    throw new Error("The report runtime source must not contain HTML script terminators");
  }
  // `<` is escaped in the JSON so report-controlled storage values cannot close the script element.
  const config = JSON.stringify({ documentPath, storage } satisfies RuntimeConfig).replaceAll("<", "\\u003c");
  return `<script>(${code})(${config});</script>`;
}

/**
 * Runs inside the sandboxed report document before any report code. It is serialized with
 * `Function.prototype.toString`, so it must be self-contained: no imports or outer references.
 *
 * Report-local URLs are any relative URL, or any URL on the document host's origin (reports often
 * build absolute URLs from `location.href`). They are resolved by the report frame from the archive
 * and replaced with blob URLs created in this document. URL-bearing properties and attributes are
 * intercepted synchronously so that no request for a report-local file reaches the network.
 */
export function installReportRuntime(config: RuntimeConfig): void {
  type Pending = { resolve: (blob: Blob) => void; reject: (error: Error) => void };
  const parentWindow = window.parent;
  const hostUrl = new URL(location.href);
  const hostPath = hostUrl.pathname;
  const hostSegments = hostPath.split("/").slice(0, -1);
  const pendingRequests = new Map<string, Pending>();
  const resolvedUrls = new Map<string, Promise<string>>();
  let nextRequestId = 0;

  // --- Storage: opaque-origin documents throw SecurityError on localStorage/sessionStorage access.
  const createStorage = (initial: Record<string, string>, persist: boolean): Storage => {
    const values = new Map(Object.entries(initial));
    const storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(String(key)) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => void values.delete(String(key)),
      setItem: (key: string, value: string) => {
        values.set(String(key), String(value));
        if (persist) {
          parentWindow.postMessage({ type: "storage-write", key: String(key), value: String(value) }, "*");
        }
      },
    };
    // Support property-style access (`localStorage.theme = "dark"`) like the native Storage object.
    return new Proxy(storage, {
      get: (target, property) =>
        typeof property === "string" && !(property in target) ? (values.get(property) ?? undefined) : Reflect.get(target, property),
      set: (target, property, value) => {
        if (typeof property === "string" && !(property in target)) {
          target.setItem(property, value);
        }
        return true;
      },
      deleteProperty: (_target, property) => (typeof property === "string" ? values.delete(property) : true),
      has: (target, property) => property in target || (typeof property === "string" && values.has(property)),
      ownKeys: () => [...values.keys()],
      getOwnPropertyDescriptor: (_target, property) =>
        typeof property === "string" && values.has(property)
          ? { configurable: true, enumerable: true, value: values.get(property), writable: true }
          : undefined,
    }) as unknown as Storage;
  };
  Object.defineProperties(window, {
    localStorage: { configurable: true, value: createStorage(config.storage, true) },
    sessionStorage: { configurable: true, value: createStorage({}, false) },
  });

  // --- Reference classification and resolution.
  /** Returns the reference relative to the current document ("/x" = archive root), or undefined if not local. */
  const localReference = (value: unknown): string | undefined => {
    const text = (value instanceof URL ? value.href : typeof value === "string" ? value : "").trim();
    if (!text || text.startsWith("#") || /^(?:data|blob|about|javascript|mailto|tel):/iu.test(text)) {
      return undefined;
    }
    const absolute = /^[a-z][a-z\d+.-]*:/iu.test(text) || text.startsWith("//");
    if (!absolute && text.startsWith("/")) {
      return text;
    }
    // A relative reference is resolved by the report frame against the archive document path, which
    // is exact; URL resolution against the host page can lose "../" segments near the origin root.
    // This holds unless the report changed its <base> to another directory.
    if (!absolute && new URL(".", document.baseURI).href === new URL(".", hostUrl).href) {
      return text;
    }
    let url: URL;
    try {
      url = new URL(text, document.baseURI);
    } catch {
      return undefined;
    }
    if (url.origin !== hostUrl.origin || url.pathname === hostPath) {
      return undefined;
    }
    const target = url.pathname.split("/");
    let common = 0;
    while (common < hostSegments.length && common < target.length - 1 && hostSegments[common] === target[common]) {
      common += 1;
    }
    return "../".repeat(hostSegments.length - common) + target.slice(common).join("/");
  };

  const requestBlob = (reference: string, documentPath: string): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const id = String(nextRequestId++);
      pendingRequests.set(id, { resolve, reject });
      parentWindow.postMessage({ type: "resource-request", id, documentPath, reference }, "*");
    });

  const resourceUrl = (reference: string, documentPath = config.documentPath, chain: string[] = []): Promise<string> => {
    const key = `${documentPath}\u0000${reference}`;
    let url = resolvedUrls.get(key);
    if (!url) {
      url = requestBlob(reference, documentPath).then(async (blob) =>
        URL.createObjectURL(blob.type === "text/css" ? new Blob([await rewriteCss(await blob.text(), [...chain, key])], { type: blob.type }) : blob),
      );
      resolvedUrls.set(key, url);
    }
    return url;
  };

  // The report frame rewrites runtime-loaded stylesheets so local references are archive-root paths.
  const rewriteCss = async (css: string, chain: string[]): Promise<string> => {
    const matches = [...css.matchAll(/url\(\s*(['"]?)(\/[^/'")][^'")]*)\1\s*\)/gu)];
    const urls = await Promise.all(
      matches.map((match) => {
        const key = `${config.documentPath}\u0000${match[2]}`;
        return chain.includes(key) ? Promise.resolve(match[2]) : resourceUrl(match[2], config.documentPath, chain).catch(() => match[2]);
      }),
    );
    let result = css;
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const start = matches[index].index ?? 0;
      result = `${result.slice(0, start)}url("${urls[index]}")${result.slice(start + matches[index][0].length)}`;
    }
    return result;
  };

  window.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; id?: unknown; blob?: unknown; error?: unknown } | null;
    if (event.source !== parentWindow || data?.type !== "resource-response" || typeof data.id !== "string") {
      return;
    }
    const pending = pendingRequests.get(data.id);
    pendingRequests.delete(data.id);
    if (data.blob instanceof Blob) {
      pending?.resolve(data.blob);
    } else {
      pending?.reject(new Error(typeof data.error === "string" ? data.error : "Missing report resource"));
    }
  });

  // --- Element URLs: properties, setAttribute, markup insertion, and a MutationObserver backstop.
  const URL_ATTRIBUTES: Record<string, string[]> = {
    data: ["OBJECT"],
    href: ["LINK"],
    poster: ["VIDEO"],
    src: ["AUDIO", "EMBED", "IFRAME", "IMG", "INPUT", "SCRIPT", "SOURCE", "TRACK", "VIDEO"],
    srcset: ["IMG", "SOURCE"],
  };
  const nativeSetAttribute = Element.prototype.setAttribute;
  const nativeRemoveAttribute = Element.prototype.removeAttribute;
  const latestRequest = new WeakMap<Element, Map<string, string>>();
  const handles = (element: Element, attribute: string): boolean =>
    element.ownerDocument === document && (URL_ATTRIBUTES[attribute]?.includes(element.tagName) ?? false);

  const applyUrl = (element: Element, attribute: string, value: Promise<string>, label: string): void => {
    let latest = latestRequest.get(element);
    if (!latest) {
      latest = new Map();
      latestRequest.set(element, latest);
    }
    latest.set(attribute, label);
    value.then(
      (url) => {
        if (latest.get(attribute) !== label) {
          return;
        }
        latest.delete(attribute);
        nativeSetAttribute.call(element, attribute, url);
        if ((element.tagName === "SOURCE" || element.tagName === "TRACK") && element.parentElement instanceof HTMLMediaElement) {
          element.parentElement.load();
        }
      },
      () => console.warn("Missing report resource:", label),
    );
  };

  const resolveSrcset = (value: string, documentPath: string): Promise<string> | undefined => {
    let local = false;
    const candidates = value.split(",").map((candidate) => {
      const [reference = "", ...descriptor] = candidate.trim().split(/\s+/u);
      const path = localReference(reference);
      if (path === undefined) {
        return Promise.resolve(candidate.trim());
      }
      local = true;
      return resourceUrl(path, documentPath).then((url) => [url, ...descriptor].join(" "));
    });
    return local ? Promise.all(candidates).then((parts) => parts.join(", ")) : undefined;
  };

  /** Starts resolving a local URL assignment. Returns false when the native assignment should proceed. */
  const assign = (element: Element, attribute: string, value: unknown, documentPath = config.documentPath): boolean => {
    if (!handles(element, attribute)) {
      return false;
    }
    if (attribute === "srcset") {
      const srcset = resolveSrcset(String(value), documentPath);
      if (srcset) {
        applyUrl(element, attribute, srcset, String(value));
      }
      return srcset !== undefined;
    }
    const reference = localReference(value);
    if (reference === undefined) {
      latestRequest.get(element)?.delete(attribute);
      return false;
    }
    applyUrl(element, attribute, resourceUrl(reference, documentPath), reference);
    return true;
  };

  const urlProperties: [{ prototype: object }, string][] = [
    [HTMLEmbedElement, "src"],
    [HTMLIFrameElement, "src"],
    [HTMLImageElement, "src"],
    [HTMLImageElement, "srcset"],
    [HTMLInputElement, "src"],
    [HTMLLinkElement, "href"],
    [HTMLMediaElement, "src"],
    [HTMLObjectElement, "data"],
    [HTMLScriptElement, "src"],
    [HTMLSourceElement, "src"],
    [HTMLSourceElement, "srcset"],
    [HTMLTrackElement, "src"],
    [HTMLVideoElement, "poster"],
  ];
  for (const [constructor, property] of urlProperties) {
    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, property);
    const nativeSet = descriptor?.set;
    if (!descriptor || !nativeSet) {
      continue;
    }
    Object.defineProperty(constructor.prototype, property, {
      ...descriptor,
      set(this: Element, value: unknown) {
        if (!assign(this, property, value)) {
          nativeSet.call(this, value);
        }
      },
    });
  }
  Element.prototype.setAttribute = function setAttribute(this: Element, name: string, value: string): void {
    if (!assign(this, String(name).toLowerCase(), value)) {
      nativeSetAttribute.call(this, name, value);
    }
  };

  // Markup is parsed into an inert template first so local URLs are swapped before anything loads.
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const parseInert = (markup: string): { fragment: DocumentFragment; assignments: [Element, string, string][] } => {
    const template = document.createElement("template");
    innerHtml?.set?.call(template, markup);
    const assignments: [Element, string, string][] = [];
    for (const element of template.content.querySelectorAll("*")) {
      for (const attribute of Object.keys(URL_ATTRIBUTES)) {
        const value = element.getAttribute(attribute);
        if (value !== null && URL_ATTRIBUTES[attribute].includes(element.tagName)) {
          const local = attribute === "srcset" ? value.split(",").some((part) => localReference(part.trim().split(/\s+/u)[0]) !== undefined) : localReference(value) !== undefined;
          if (local) {
            nativeRemoveAttribute.call(element, attribute);
            assignments.push([element, attribute, value]);
          }
        }
      }
    }
    return { fragment: template.content, assignments };
  };
  const mayContainUrls = (markup: unknown): markup is string => typeof markup === "string" && /\s(?:src|srcset|poster|data|href)\s*=/iu.test(markup);
  if (innerHtml?.set) {
    const nativeInnerHtmlSet = innerHtml.set;
    Object.defineProperty(Element.prototype, "innerHTML", {
      ...innerHtml,
      set(this: Element, markup: unknown) {
        if (this.ownerDocument !== document || this instanceof HTMLTemplateElement || !mayContainUrls(markup)) {
          nativeInnerHtmlSet.call(this, markup);
          return;
        }
        const { fragment, assignments } = parseInert(markup);
        nativeInnerHtmlSet.call(this, "");
        this.append(fragment);
        for (const [element, attribute, value] of assignments) {
          assign(element, attribute, value);
        }
      },
    });
  }
  const nativeInsertAdjacentHtml = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function insertAdjacentHTML(this: Element, position: InsertPosition, markup: string): void {
    if (this.ownerDocument !== document || !mayContainUrls(markup)) {
      nativeInsertAdjacentHtml.call(this, position, markup);
      return;
    }
    const { fragment, assignments } = parseInert(markup);
    const where = String(position).toLowerCase();
    if (where === "beforebegin") this.before(fragment);
    else if (where === "afterbegin") this.prepend(fragment);
    else if (where === "afterend") this.after(fragment);
    else this.append(fragment);
    for (const [element, attribute, value] of assignments) {
      assign(element, attribute, value);
    }
  };

  /** Resolves `data-report-*` references prepared by the report frame (archive-root paths). */
  const activateDeferred = (element: Element): void => {
    for (const attribute of Object.keys(URL_ATTRIBUTES).concat(element.tagName.toLowerCase() === "use" ? ["href"] : [])) {
      const deferred = element.getAttribute(`data-report-${attribute}`);
      if (deferred === null) {
        continue;
      }
      nativeRemoveAttribute.call(element, `data-report-${attribute}`);
      if (attribute === "srcset") {
        const srcset = resolveSrcset(deferred, config.documentPath);
        if (srcset) {
          applyUrl(element, attribute, srcset, deferred);
        }
      } else {
        applyUrl(element, attribute, resourceUrl(deferred), deferred);
      }
    }
    const missing = element.getAttribute("data-report-missing");
    if (missing !== null) {
      nativeRemoveAttribute.call(element, "data-report-missing");
      console.warn("Missing report resource:", missing);
    }
  };
  const deferredSelector = "[data-report-src], [data-report-srcset], [data-report-poster], [data-report-href], [data-report-data], [data-report-missing]";
  const visit = (node: Node): void => {
    if (!(node instanceof Element)) {
      return;
    }
    for (const element of [node, ...node.querySelectorAll("*")]) {
      activateDeferred(element);
      for (const attribute of Object.keys(URL_ATTRIBUTES)) {
        const value = element.getAttribute(attribute);
        if (value !== null && handles(element, attribute) && (attribute === "srcset" || localReference(value) !== undefined)) {
          assign(element, attribute, value);
        }
      }
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach(visit);
      } else if (record.attributeName && record.target instanceof Element) {
        const value = record.target.getAttribute(record.attributeName);
        if (value !== null && localReference(value) !== undefined) {
          assign(record.target, record.attributeName, value);
        }
      }
    }
  }).observe(document, { attributeFilter: Object.keys(URL_ATTRIBUTES), attributes: true, childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => document.querySelectorAll(deferredSelector).forEach(activateDeferred));

  // --- fetch, XMLHttpRequest, Worker, and window.open.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const reference = localReference(input instanceof Request ? input.url : input);
    if (reference === undefined) {
      return nativeFetch(input, init);
    }
    return resourceUrl(reference).then(
      (url) => nativeFetch(url, input instanceof Request ? { method: input.method, ...init } : init),
      () => new Response(null, { status: 404, statusText: "Missing from report archive" }),
    );
  };

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const pendingXhr = new WeakMap<XMLHttpRequest, { method: string; reference: string; user?: string | null; password?: string | null }>();
  XMLHttpRequest.prototype.open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    user?: string | null,
    password?: string | null,
  ): void {
    const reference = localReference(url);
    if (reference === undefined) {
      pendingXhr.delete(this);
      nativeXhrOpen.call(this, method, url, async, user, password);
      return;
    }
    if (!async) {
      throw new DOMException("Synchronous XMLHttpRequest is not supported for report files", "NotSupportedError");
    }
    pendingXhr.set(this, { method, reference, user, password });
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const request = pendingXhr.get(this);
    if (!request) {
      nativeXhrSend.call(this, body);
      return;
    }
    pendingXhr.delete(this);
    resourceUrl(request.reference).then(
      (url) => {
        nativeXhrOpen.call(this, request.method, url, true, request.user, request.password);
        nativeXhrSend.call(this, body);
      },
      () => {
        this.dispatchEvent(new ProgressEvent("error"));
        this.dispatchEvent(new ProgressEvent("loadend"));
      },
    );
  };

  // Classic workers from report files start from a blob trampoline that imports the real script
  // once resolved, replaying any messages the page posted in the meantime.
  const NativeWorker = window.Worker;
  window.Worker = class ReportWorker extends NativeWorker {
    constructor(scriptUrl: string | URL, options?: WorkerOptions) {
      const reference = options?.type === "module" ? undefined : localReference(scriptUrl);
      if (reference === undefined) {
        super(scriptUrl, options);
        return;
      }
      const trampoline = [
        "var queued = [];",
        "self.onmessage = function (event) {",
        "  if (event.data && event.data.__reportWorkerScript) {",
        "    self.onmessage = null;",
        "    importScripts(event.data.__reportWorkerScript);",
        "    queued.forEach(function (data) { self.dispatchEvent(new MessageEvent('message', { data: data })); });",
        "  } else { queued.push(event.data); }",
        "};",
      ].join("\n");
      super(URL.createObjectURL(new Blob([trampoline], { type: "text/javascript" })), options);
      resourceUrl(reference).then(
        (url) => NativeWorker.prototype.postMessage.call(this, { __reportWorkerScript: url }),
        () => console.warn("Missing report resource:", reference),
      );
    }
  } as typeof Worker;

  const nativeOpen = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string): WindowProxy | null => {
    const reference = localReference(url);
    if (reference === undefined) {
      return nativeOpen(url, target, features);
    }
    const popup = nativeOpen("about:blank", target, features);
    resourceUrl(reference).then(
      (resource) => (popup ? popup.location.replace(resource) : nativeOpen(resource, target, features)),
      () => console.warn("Missing report resource:", reference),
    );
    return popup;
  };

  // --- Links: other report pages navigate through the report frame; other files open or download.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement | HTMLAreaElement>("a[href], area[href]") : null;
    const href = anchor?.getAttribute("href");
    const reference = localReference(href);
    if (!anchor || !href || reference === undefined) {
      return;
    }
    event.preventDefault();
    const url = new URL(href, document.baseURI);
    const path = reference.split(/[?#]/u, 1)[0];
    if (/\.x?html?$/iu.test(path)) {
      parentWindow.postMessage({ type: "navigate", documentPath: config.documentPath, reference: `${path}${url.search}${url.hash}` }, "*");
      return;
    }
    resourceUrl(path).then(
      (resource) => {
        if (anchor.target === "_blank" && !anchor.hasAttribute("download")) {
          nativeOpen(resource, "_blank");
          return;
        }
        const link = document.createElement("a");
        nativeSetAttribute.call(link, "href", resource);
        link.download = anchor.getAttribute("download") || decodeURIComponent(path.split("/").pop() ?? "download");
        document.body.append(link);
        link.click();
        link.remove();
      },
      () => console.warn("Missing report resource:", path),
    );
  });
}
