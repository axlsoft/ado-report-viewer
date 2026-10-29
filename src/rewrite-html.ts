import { resolveArchivePath } from "./paths";
import type { ResourceResolver } from "./rewrite-css";

const URL_ATTRIBUTES = ["src", "poster", "data"];

export async function rewriteHtml(html: string, documentPath: string, resolver: ResourceResolver): Promise<string> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const elements = [...parsed.querySelectorAll<HTMLElement>("*")];

  for (const element of elements) {
    for (const attribute of URL_ATTRIBUTES) {
      await rewriteAttribute(element, attribute, documentPath, resolver);
    }
    if (element.matches("link[rel~='stylesheet'], script[src], source[src], track[src], object[data], embed[src], use[href]")) {
      await rewriteAttribute(element, element.hasAttribute("href") ? "href" : "src", documentPath, resolver);
    }
    if (element.hasAttribute("srcset")) {
      const rewritten = await rewriteSrcset(element.getAttribute("srcset") ?? "", documentPath, resolver);
      element.setAttribute("srcset", rewritten);
    }
  }

  for (const anchor of parsed.querySelectorAll<HTMLAnchorElement>("a[href], area[href]")) {
    const reference = anchor.getAttribute("href") ?? "";
    const path = resolveArchivePath(documentPath, reference);
    if (path?.match(/\.x?html?$/iu)) {
      anchor.dataset.reportPath = path;
      anchor.href = "#";
    } else if (path) {
      anchor.href = await resolver.resourceUrl(path);
    }
  }

  const refresh = parsed.querySelector<HTMLMetaElement>("meta[http-equiv='refresh' i][content]");
  if (refresh) {
    refresh.remove();
  }

  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

async function rewriteAttribute(
  element: HTMLElement,
  attribute: string,
  documentPath: string,
  resolver: ResourceResolver,
): Promise<void> {
  const reference = element.getAttribute(attribute);
  if (!reference) {
    return;
  }
  const path = resolveArchivePath(documentPath, reference);
  if (path) {
    element.setAttribute(attribute, await resolver.resourceUrl(path));
  }
}

async function rewriteSrcset(value: string, documentPath: string, resolver: ResourceResolver): Promise<string> {
  return Promise.all(
    value.split(",").map(async (candidate) => {
      const [reference, ...descriptor] = candidate.trim().split(/\s+/u);
      const path = resolveArchivePath(documentPath, reference);
      return path ? `${await resolver.resourceUrl(path)} ${descriptor.join(" ")}`.trim() : candidate.trim();
    }),
  ).then((candidates) => candidates.join(", "));
}