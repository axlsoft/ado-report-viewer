import { resolveArchivePath } from "./paths";
import type { ResourceResolver } from "./rewrite-css";

const URL_ATTRIBUTES = ["src", "poster", "data"];

export async function rewriteHtml(html: string, documentPath: string, resolver: ResourceResolver): Promise<string> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const elements = [...parsed.querySelectorAll<HTMLElement>("*")];

  for (const element of elements) {
    for (const attribute of URL_ATTRIBUTES) {
      deferAttribute(element, attribute, documentPath);
    }
    if (element.matches("link[rel~='stylesheet'], script[src], source[src], track[src], object[data], embed[src], use[href]")) {
      deferAttribute(element, element.hasAttribute("href") ? "href" : "src", documentPath);
    }
    if (element.hasAttribute("srcset")) {
      deferSrcset(element, documentPath);
    }
  }

  for (const anchor of parsed.querySelectorAll<HTMLAnchorElement>("a[href], area[href]")) {
    const reference = anchor.getAttribute("href") ?? "";
    const path = resolveArchivePath(documentPath, reference);
    if (path?.match(/\.x?html?$/iu)) {
      anchor.dataset.reportPath = path;
      anchor.href = "#";
    } else if (path) {
      anchor.dataset.reportReference = path;
      anchor.href = "#";
    }
  }

  const refresh = parsed.querySelector<HTMLMetaElement>("meta[http-equiv='refresh' i][content]");
  if (refresh) {
    refresh.remove();
  }

  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function deferAttribute(element: HTMLElement, attribute: string, documentPath: string): void {
  const reference = element.getAttribute(attribute);
  if (!reference) {
    return;
  }
  const path = resolveArchivePath(documentPath, reference);
  if (path) {
    element.dataset.reportReference = path;
    element.setAttribute(attribute, "about:blank");
  }
}

function deferSrcset(element: HTMLElement, documentPath: string): void {
  const candidates = (element.getAttribute("srcset") ?? "").split(",").map((candidate) => {
    const [reference, ...descriptor] = candidate.trim().split(/\s+/u);
    const path = resolveArchivePath(documentPath, reference);
    return path ? `${path} ${descriptor.join(" ")}`.trim() : candidate.trim();
  });
  element.dataset.reportSrcset = candidates.join(", ");
  element.setAttribute("srcset", "");
}