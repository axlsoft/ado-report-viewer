import { isLoadReportMessage, type FrameStatusMessage, type ReportDescriptor } from "./protocol";
import { resolveArchivePath } from "./paths";
import { rewriteCss, type ResourceResolver } from "./rewrite-css";
import { rewriteHtml } from "./rewrite-html";
import { runtimeShim } from "./runtime-shim";
import { ZipArchive } from "./zip";

const root = document.querySelector<HTMLElement>("#report-root");
let activeArchive: ZipArchive | undefined;
let activeReport: ReportDescriptor | undefined;
let childFrame: HTMLIFrameElement | undefined;
const objectUrls = new Set<string>();

window.addEventListener("message", (event) => {
  if (event.source === window.parent && isLoadReportMessage(event.data)) {
    void loadReport(event.data.report, event.data.archive);
  }
});

postToOpaqueWindow(window.parent, { type: "frame-status", status: "ready" satisfies FrameStatusMessage["status"] });

async function loadReport(report: ReportDescriptor, archiveBlob: Blob): Promise<void> {
  cleanup();
  activeReport = report;
  activeArchive = await ZipArchive.open(archiveBlob);
  await renderDocument(report.entryPath);
}

async function renderDocument(path: string): Promise<void> {
  if (!activeArchive || !activeReport || !root) {
    return;
  }

  try {
    const source = await activeArchive.read(path);
    const html = await source.text();
    const resolver: ResourceResolver = {
      resourceUrl: (resourcePath) => resourceUrl(resourcePath),
    };
    const rewritten = await rewriteHtml(html, path, resolver);
    const frame = document.createElement("iframe");
    frame.title = activeReport.displayName;
    frame.sandbox.add("allow-scripts", "allow-downloads", "allow-popups");
    frame.srcdoc = injectRuntime(rewritten, path);
    frame.addEventListener("load", () => {
      if (frame.contentWindow) {
        postToOpaqueWindow(frame.contentWindow, { type: "rendered" });
      }
    });
    childFrame = frame;
    root.replaceChildren(frame);
    postToOpaqueWindow(window.parent, { type: "frame-status", status: "rendered" } satisfies FrameStatusMessage);
  } catch (error) {
    showError(error);
  }
}

async function resourceUrl(path: string): Promise<string> {
  if (!activeArchive) {
    throw new Error("No active report archive");
  }
  const blob = await activeArchive.read(path);
  if (blob.type === "text/css") {
    const cssUrl = URL.createObjectURL(new Blob([await rewriteCss(await blob.text(), path, { resourceUrl })], { type: blob.type }));
    objectUrls.add(cssUrl);
    return cssUrl;
  }
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function injectRuntime(html: string, documentPath: string): string {
  return html.replace(/<head([^>]*)>/iu, `<head$1>${runtimeShim(documentPath)}`);
}

window.addEventListener("message", (event) => {
  if (event.source !== childFrame?.contentWindow || !isRecord(event.data)) {
    return;
  }
  if (event.data.type === "navigate" && typeof event.data.path === "string") {
    const path = resolveArchivePath("", event.data.path);
    if (path) {
      void renderDocument(path);
    }
  }
  if (
    event.data.type === "resource-request" &&
    typeof event.data.id === "string" &&
    typeof event.data.documentPath === "string" &&
    typeof event.data.reference === "string"
  ) {
    void respondWithResource(event.source as WindowProxy, event.data.id, event.data.documentPath, event.data.reference);
  }
  if (event.data.type === "storage-write" && typeof event.data.key === "string" && typeof event.data.value === "string") {
    postToOpaqueWindow(window.parent, event.data);
  }
});

async function respondWithResource(
  target: WindowProxy,
  id: string,
  documentPath: string,
  reference: string,
): Promise<void> {
  if (!activeArchive) {
    return;
  }
  try {
    const path = resolveArchivePath(documentPath, reference);
    if (!path) {
      throw new Error("External URLs are not served from the report archive");
    }
    const url = await resourceUrl(path);
    messageChild(target, { type: "resource-response", id, url });
  } catch (error) {
    messageChild(target, { type: "resource-response", id, error: error instanceof Error ? error.message : "Missing report resource" });
  }
}

function messageChild(target: WindowProxy, message: unknown): void {
  postToOpaqueWindow(target, message);
}

function postToOpaqueWindow(target: WindowProxy, message: unknown): void {
  // The receiving sandbox has opaque origin "null"; the browser requires wildcard delivery.
  // @ts-expect-error TypeScript 7's WindowProxy declaration rejects the standard string overload.
  target.postMessage(message, "*");
}

function cleanup(): void {
  childFrame?.remove();
  childFrame = undefined;
  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }
  objectUrls.clear();
}

function showError(error: unknown): void {
  if (root) {
    root.textContent = error instanceof Error ? error.message : "Unable to render this report archive.";
  }
  postToOpaqueWindow(
    window.parent,
    { type: "frame-status", status: "error", detail: error instanceof Error ? error.message : undefined } satisfies FrameStatusMessage,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}