import { isHtmlPath, resolveArchivePath } from "./paths";
import type { DocumentResource } from "./protocol";
import { rewriteCss } from "./rewrite-css";

export interface ArchiveReader {
  read(path: string): Promise<Blob>;
}

export interface RewriteOptions {
  /** URL of the report document host for an archive path, used for refresh redirects. */
  documentUrl(path: string, search: string, hash: string): string;
}

export interface RewrittenDocument {
  html: string;
  resources: DocumentResource[];
}

// Attributes that load lazily: the runtime shim resolves `data-report-<attribute>` after render.
const DEFERRED_ATTRIBUTES: Record<string, string> = {
  audio: "src",
  embed: "src",
  iframe: "src",
  img: "src",
  input: "src",
  object: "data",
  source: "src",
  track: "src",
  video: "src",
};

/**
 * Prepares a report document for the sandboxed document host. Stylesheets (recursively, with their
 * fonts and images) and classic scripts are needed before first paint, so they are read eagerly and
 * replaced by tokens that the host turns into blob URLs before writing the document. Everything else
 * is deferred to the runtime shim so large media is only inflated when used.
 */
export async function rewriteHtml(
  html: string,
  documentPath: string,
  archive: ArchiveReader,
  options: RewriteOptions,
): Promise<RewrittenDocument> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const bundle = new ResourceBundle(archive);
  const pending: Promise<void>[] = [];

  for (const element of parsed.querySelectorAll<HTMLElement>("*")) {
    const tag = element.localName;
    if (tag === "script" && element.hasAttribute("src")) {
      pending.push(tokenize(element, "src", documentPath, bundle));
    } else if (tag === "link" && element.hasAttribute("href")) {
      if (/(?:^|\s)stylesheet(?:\s|$)/iu.test(element.getAttribute("rel") ?? "")) {
        pending.push(tokenize(element, "href", documentPath, bundle));
      } else {
        defer(element, "href", documentPath);
      }
    } else if (tag === "style") {
      pending.push(rewriteInlineCss(element.textContent ?? "", documentPath, bundle).then((css) => void (element.textContent = css)));
    }

    const deferred = DEFERRED_ATTRIBUTES[tag];
    if (deferred) {
      defer(element, deferred, documentPath);
    }
    if (tag === "video") {
      defer(element, "poster", documentPath);
    }
    if ((tag === "img" || tag === "source") && element.hasAttribute("srcset")) {
      deferSrcset(element, documentPath);
    }
    const style = element.getAttribute("style");
    if (style?.includes("url(")) {
      pending.push(rewriteInlineCss(style, documentPath, bundle).then((css) => element.setAttribute("style", css)));
    }
  }

  for (const use of parsed.querySelectorAll("use[href]")) {
    defer(use, "href", documentPath);
  }

  const refresh = parsed.querySelector<HTMLMetaElement>("meta[http-equiv='refresh' i][content]");
  if (refresh) {
    rewriteRefresh(refresh, documentPath, options);
  }

  await Promise.all(pending);
  return { html: `<!doctype html>\n${parsed.documentElement.outerHTML}`, resources: bundle.resources };
}

class ResourceBundle {
  readonly resources: DocumentResource[] = [];
  private readonly entries = new Map<string, { token: string; added: Promise<void> }>();

  constructor(private readonly archive: ArchiveReader) {}

  /**
   * Returns the token for an archive path, reading each path once. `chain` holds the stylesheets
   * currently being expanded; a reference back into the chain is an `@import` cycle and resolves
   * to the existing token without waiting.
   */
  async token(path: string, chain: ReadonlySet<string> = new Set()): Promise<string> {
    const existing = this.entries.get(path);
    if (existing) {
      if (!chain.has(path)) {
        await existing.added;
      }
      return existing.token;
    }
    const token = `__report_resource_${this.entries.size}__`;
    const added = this.add(path, token, new Set([...chain, path]));
    this.entries.set(path, { token, added });
    await added;
    return token;
  }

  private async add(path: string, token: string, chain: ReadonlySet<string>): Promise<void> {
    const blob = await this.archive.read(path);
    if (blob.type === "text/css") {
      // Dependencies are pushed first so the document host can resolve nested tokens in order.
      const css = await rewriteCss(await blob.text(), path, { resourceUrl: (nested) => this.token(nested, chain) });
      this.resources.push({ token, blob, css });
    } else {
      this.resources.push({ token, blob });
    }
  }
}

async function tokenize(element: HTMLElement, attribute: string, documentPath: string, bundle: ResourceBundle): Promise<void> {
  const path = resolveArchivePath(documentPath, element.getAttribute(attribute) ?? "");
  if (!path) {
    return;
  }
  try {
    element.setAttribute(attribute, await bundle.token(path));
  } catch {
    markMissing(element, attribute, path);
  }
}

async function rewriteInlineCss(css: string, documentPath: string, bundle: ResourceBundle): Promise<string> {
  return rewriteCss(css, documentPath, {
    resourceUrl: async (path) => {
      try {
        return await bundle.token(path);
      } catch {
        return `missing:${path}`;
      }
    },
  });
}

function defer(element: Element, attribute: string, documentPath: string): void {
  const reference = element.getAttribute(attribute);
  const path = reference ? resolveArchivePath(documentPath, reference) : undefined;
  if (path) {
    element.removeAttribute(attribute);
    element.setAttribute(`data-report-${attribute}`, `/${path}`);
  }
}

function deferSrcset(element: HTMLElement, documentPath: string): void {
  let local = false;
  const candidates = (element.getAttribute("srcset") ?? "").split(",").map((candidate) => {
    const [reference = "", ...descriptor] = candidate.trim().split(/\s+/u);
    const path = resolveArchivePath(documentPath, reference);
    local ||= path !== undefined;
    return path ? [`/${path}`, ...descriptor].join(" ") : candidate.trim();
  });
  if (local) {
    element.removeAttribute("srcset");
    element.setAttribute("data-report-srcset", candidates.join(", "));
  }
}

function markMissing(element: HTMLElement, attribute: string, path: string): void {
  element.removeAttribute(attribute);
  element.setAttribute("data-report-missing", path);
}

function rewriteRefresh(refresh: HTMLMetaElement, documentPath: string, options: RewriteOptions): void {
  const match = /^(\s*\d+(?:\.\d+)?\s*[;,]\s*(?:url\s*=\s*)?)(['"]?)(.*?)\2\s*$/iu.exec(refresh.content);
  if (!match) {
    return;
  }
  const reference = match[3];
  const path = resolveArchivePath(documentPath, reference);
  if (!path) {
    return;
  }
  if (!isHtmlPath(path)) {
    refresh.remove();
    return;
  }
  const url = new URL(reference, "https://report.invalid/");
  refresh.content = `${match[1]}${options.documentUrl(path, url.search, url.hash)}`;
}
