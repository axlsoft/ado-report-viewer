import * as SDK from "azure-devops-extension-sdk";
import { listBuildReports, type BuildReport } from "./ado";
import { isFrameToTabMessage, type ReportDescriptor } from "./protocol";
import "./styles.css";

const MAX_CACHED_REPORTS = 3;
const MAX_PERSISTED_STORAGE_BYTES = 16 * 1024;
const PERSISTED_STORAGE_KEYS = new Set(["theme", "filters"]);
const app = document.querySelector<HTMLElement>("#app");
const reportCache = new Map<string, Blob>();
let reportFrame: HTMLIFrameElement | undefined;

void initialize();

async function initialize(): Promise<void> {
  try {
    SDK.init({ applyTheme: true, loaded: false });
    SDK.notifyLoadSucceeded();
    const reports = await listBuildReports();
    renderHostedReports(reports);
    return;
  } catch {
    // The local harness deliberately runs without the Azure DevOps host.
  }
  renderHarness();
}

function renderHostedReports(reports: readonly BuildReport[]): void {
  if (!app) {
    return;
  }
  if (reports.length === 0) {
    app.textContent = "No HTML reports are attached to this run. Use publish-html-report.yml to attach one.";
    return;
  }

  const shell = document.createElement("section");
  shell.className = "report-shell";
  const toolbar = document.createElement("header");
  toolbar.className = "report-toolbar";
  const selector = document.createElement("select");
  selector.setAttribute("aria-label", "Select report");
  for (const report of reports) {
    selector.add(new Option(report.displayName, report.id));
  }
  selector.addEventListener("change", () => {
    const selected = reports.find((report) => report.id === selector.value);
    if (selected) {
      void downloadAndOpen(selected);
    }
  });
  toolbar.append(selector);
  shell.append(toolbar);
  app.replaceChildren(shell);
  void downloadAndOpen(reports[0]);
}

async function downloadAndOpen(report: BuildReport): Promise<void> {
  try {
    const archive = reportCache.get(report.id) ?? (await report.download());
    openReport(report, archive);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "Unable to download report archive.");
  }
}

function renderHarness(): void {
  if (!app) {
    return;
  }
  const shell = document.createElement("section");
  shell.className = "report-shell";
  const toolbar = document.createElement("header");
  toolbar.className = "report-toolbar";
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".zip,application/zip";
  picker.setAttribute("aria-label", "Choose a report archive");
  picker.addEventListener("change", () => {
    const archive = picker.files?.item(0);
    if (archive) {
      openReport({ id: archive.name, displayName: archive.name, entryPath: "index.html" }, archive);
    }
  });
  toolbar.append(picker);
  shell.append(toolbar);
  app.replaceChildren(shell);
}

function openReport(report: ReportDescriptor, archive: Blob): void {
  if (!app) {
    return;
  }
  remember(report.id, archive);
  reportFrame?.remove();
  reportFrame = document.createElement("iframe");
  reportFrame.className = "report-frame";
  reportFrame.title = report.displayName;
  reportFrame.sandbox.add("allow-scripts", "allow-downloads", "allow-popups");
  reportFrame.src = new URL("./frame.html", import.meta.url).toString();
  reportFrame.addEventListener("load", () => {
    reportFrame?.contentWindow?.postMessage({ type: "load-report", report, archive }, "*");
  });
  reportFrame.addEventListener("error", () => showStatus("Unable to load the report frame."));
  app.querySelector(".report-shell")?.append(reportFrame);
}

window.addEventListener("message", (event) => {
  if (event.source !== reportFrame?.contentWindow || !isFrameToTabMessage(event.data)) {
    return;
  }
  if (event.data.type === "frame-status") {
    showStatus(event.data.status === "error" ? event.data.detail ?? "Unable to render report." : "");
  }
  if (event.data.type === "storage-write" && PERSISTED_STORAGE_KEYS.has(event.data.key)) {
    const value = event.data.value;
    if (new TextEncoder().encode(value).byteLength <= MAX_PERSISTED_STORAGE_BYTES) {
      try {
        localStorage.setItem(`html-report:${event.data.key}`, value);
      } catch {
        // Storage is an optional convenience and must not break report rendering.
      }
    }
  }
});

function remember(id: string, archive: Blob): void {
  reportCache.delete(id);
  reportCache.set(id, archive);
  while (reportCache.size > MAX_CACHED_REPORTS) {
    const oldestId = reportCache.keys().next().value as string | undefined;
    if (oldestId) {
      reportCache.delete(oldestId);
    }
  }
}

function showStatus(message: string): void {
  const existing = app?.querySelector<HTMLElement>("[role='status']");
  if (existing) {
    existing.textContent = message;
    return;
  }
  if (message && app) {
    const status = document.createElement("p");
    status.role = "status";
    status.textContent = message;
    app.prepend(status);
  }
}