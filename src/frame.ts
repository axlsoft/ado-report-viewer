import {
  isDocumentToFrameMessage,
  isLoadReportMessage,
  type FrameStatusMessage,
  type RenderDocumentMessage,
  type ReportDescriptor,
  type ResourceResponseMessage,
} from "./protocol";
import { isHtmlPath, resolveArchivePath } from "./paths";
import { rewriteCss } from "./rewrite-css";
import { rewriteHtml } from "./rewrite-html";
import { runtimeShim } from "./runtime-shim";
import { ZipArchive } from "./zip";

const DOCUMENT_PARAMETER = "__report";
// Report documents may only load what the report frame serves (as blob: URLs) or what they embed.
// Every other origin, including the extension origin, is blocked before any request is sent.
const REPORT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data:",
  "style-src 'unsafe-inline' blob: data:",
  "img-src blob: data:",
  "font-src blob: data:",
  "media-src blob: data:",
  "connect-src blob: data:",
  "worker-src blob:",
  "frame-src blob: data:",
  "object-src blob: data:",
].join("; ");
const documentHostUrl = new URL("report-document.html", document.baseURI);
const root = document.querySelector<HTMLElement>("#report-root");
let activeArchive: ZipArchive | undefined;
let activeReport: ReportDescriptor | undefined;
let activeStorage: Record<string, string> = {};
let documentFrame: HTMLIFrameElement | undefined;

window.addEventListener("message", (event) => {
  if (event.source === window.parent && isLoadReportMessage(event.data)) {
    void loadReport(event.data.report, event.data.archive, event.data.storage ?? {});
    return;
  }
  if (!documentFrame || event.source !== documentFrame.contentWindow || !isDocumentToFrameMessage(event.data)) {
    return;
  }
  const source = event.source as WindowProxy;
  const message = event.data;
  switch (message.type) {
    case "document-ready":
      void renderDocument(source, new URLSearchParams(message.search).get(DOCUMENT_PARAMETER) ?? "");
      break;
    case "resource-request":
      void respondWithResource(source, message.id, message.documentPath, message.reference);
      break;
    case "navigate":
      navigate(message.documentPath, message.reference);
      break;
    case "storage-write":
      postToOpaqueWindow(window.parent, message);
      break;
  }
});

postToOpaqueWindow(window.parent, { type: "frame-status", status: "ready" } satisfies FrameStatusMessage);

async function loadReport(report: ReportDescriptor, archiveBlob: Blob, storage: Record<string, string>): Promise<void> {
  documentFrame?.remove();
  documentFrame = undefined;
  activeReport = report;
  activeStorage = storage;
  try {
    activeArchive = await ZipArchive.open(archiveBlob);
  } catch (error) {
    showError(error);
    return;
  }

  const entry = chooseEntry(activeArchive, report.entryPath);
  if (typeof entry !== "string") {
    showEntryChoice(entry);
    return;
  }
  openDocumentHost(entry);
}

/** Entry fallback: the configured entry, else index.html, else the only root HTML file, else a choice. */
function chooseEntry(archive: ZipArchive, configured: string): string | string[] {
  for (const candidate of [configured, "index.html"]) {
    try {
      if (candidate && archive.has(candidate)) {
        return candidate;
      }
    } catch {
      // An invalid configured entry falls through to discovery.
    }
  }
  const rootHtml = archive.list().filter((path) => !path.includes("/") && isHtmlPath(path));
  return rootHtml.length === 1 ? rootHtml[0] : rootHtml;
}

function showEntryChoice(candidates: string[]): void {
  if (!root) {
    return;
  }
  if (candidates.length === 0) {
    showError(new Error("This report archive has no HTML file at its root."));
    return;
  }
  const list = document.createElement("ul");
  list.className = "entry-choice";
  for (const candidate of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = candidate;
    button.addEventListener("click", () => openDocumentHost(candidate));
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
  }
  const heading = document.createElement("p");
  heading.textContent = "Choose the report entry page:";
  root.replaceChildren(heading, list);
}

function openDocumentHost(path: string, search = "", hash = ""): void {
  if (!root || !activeReport) {
    return;
  }
  const frame = document.createElement("iframe");
  frame.title = activeReport.displayName;
  // No allow-same-origin: the report runs in an opaque origin and cannot reach this frame or the tab.
  frame.sandbox.add("allow-scripts", "allow-downloads", "allow-popups");
  frame.src = documentUrl(path, search, hash);
  documentFrame = frame;
  root.replaceChildren(frame);
}

/** URL of the document host for an archive document. Navigating the host frame keeps native history. */
function documentUrl(path: string, search: string, hash: string): string {
  const url = new URL(documentHostUrl);
  const parameters = new URLSearchParams(search);
  parameters.delete(DOCUMENT_PARAMETER);
  url.search = new URLSearchParams([[DOCUMENT_PARAMETER, path], ...parameters]).toString();
  url.hash = hash;
  return url.href;
}

function navigate(documentPath: string, reference: string): void {
  let path: string | undefined;
  try {
    path = resolveArchivePath(documentPath, reference);
  } catch {
    path = undefined;
  }
  if (!path || !documentFrame) {
    return;
  }
  const url = new URL(reference, "https://report.invalid/");
  documentFrame.src = documentUrl(path, url.search, url.hash);
}

async function renderDocument(target: WindowProxy, requestedPath: string): Promise<void> {
  if (!activeArchive || !activeReport) {
    return;
  }

  let message: RenderDocumentMessage;
  try {
    const path = resolveArchivePath("", requestedPath) ?? "";
    const archive = activeArchive;
    const html = await (await archive.read(path)).text();
    const rewritten = await rewriteHtml(html, path, archive, { documentUrl });
    message = { type: "render-document", html: injectRuntime(rewritten.html, path), resources: rewritten.resources };
  } catch {
    message = { type: "render-document", html: missingDocumentHtml(requestedPath), resources: [] };
    postToOpaqueWindow(window.parent, {
      type: "frame-status",
      status: "error",
      detail: `Missing from report archive: ${requestedPath}`,
    } satisfies FrameStatusMessage);
  }
  postToOpaqueWindow(target, message);
  postToOpaqueWindow(window.parent, { type: "frame-status", status: "rendered" } satisfies FrameStatusMessage);
}

function injectRuntime(html: string, documentPath: string): string {
  // The policy must be the first element so it applies before the shim or any report content loads.
  const policy = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CONTENT_SECURITY_POLICY}">`;
  const shim = `${policy}${runtimeShim(documentPath, activeStorage)}`;
  return /<head[^>]*>/iu.test(html) ? html.replace(/<head([^>]*)>/iu, (_match, attributes: string) => `<head${attributes}>${shim}`) : `${shim}${html}`;
}

function missingDocumentHtml(path: string): string {
  const escaped = path.replace(/[&<>"]/gu, (character) => `&#${character.charCodeAt(0)};`);
  return `<!doctype html><html><body style="font-family: sans-serif; padding: 16px"><p role="alert">Missing from report archive: <code>${escaped}</code></p></body></html>`;
}

async function respondWithResource(target: WindowProxy, id: string, documentPath: string, reference: string): Promise<void> {
  const archive = activeArchive;
  if (!archive) {
    return;
  }
  let response: ResourceResponseMessage;
  try {
    const path = resolveArchivePath(documentPath, reference);
    if (!path) {
      throw new Error("External URLs are not served from the report archive");
    }
    let blob = await archive.read(path);
    if (blob.type === "text/css") {
      // Runtime-loaded stylesheets: make their references archive-root paths for the shim to resolve.
      const css = await rewriteCss(await blob.text(), path, { resourceUrl: async (nested) => `/${nested}` });
      blob = new Blob([css], { type: "text/css" });
    }
    response = { type: "resource-response", id, blob };
  } catch (error) {
    response = { type: "resource-response", id, error: error instanceof Error ? error.message : "Missing report resource" };
  }
  postToOpaqueWindow(target, response);
}

function postToOpaqueWindow(target: WindowProxy, message: unknown): void {
  // The receiving sandbox has opaque origin "null"; the browser requires wildcard delivery.
  target.postMessage(message, "*");
}

function showError(error: unknown): void {
  const detail = error instanceof Error ? error.message : "Unable to render this report archive.";
  if (root) {
    root.textContent = detail;
  }
  postToOpaqueWindow(window.parent, { type: "frame-status", status: "error", detail } satisfies FrameStatusMessage);
}
