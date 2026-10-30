import * as SDK from "azure-devops-extension-sdk";
import { listBuildReports, type BuildReport, type DownloadProgress } from "./ado";
import { isFrameToTabMessage, type ReportDescriptor } from "./protocol";
import "./styles.css";

const MAX_CACHED_REPORTS = 3;
const MAX_PERSISTED_STORAGE_BYTES = 16 * 1024;
const PERSISTED_STORAGE_KEYS = new Set(["theme", "filters"]);
const app = document.querySelector<HTMLElement>("#app");
const reportCache = new Map<string, Blob>();
let reportFrame: HTMLIFrameElement | undefined;
let activeReportId: string | undefined;
let activeReport: BuildReport | undefined;
let loadSequence = 0;

void initialize();

async function initialize(): Promise<void> {
  if (window.parent === window) {
    renderHarness();
    return;
  }
  try {
    await SDK.init({ applyTheme: true, loaded: false });
    SDK.notifyLoadSucceeded();
    const reports = await listBuildReports();
    renderHostedReports(reports);
  } catch (error) {
    renderHostError(error);
  }
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
  const selectReport = (report: BuildReport): void => {
    activeReport = report;
    void downloadAndOpen(report);
  };

  if (reports.length <= 4) {
    const switcher = document.createElement("div");
    switcher.className = "report-switcher";
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "Select report");
    for (const report of reports) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = report.displayName;
      button.className = "report-choice";
      button.addEventListener("click", () => {
        for (const choice of switcher.querySelectorAll<HTMLButtonElement>("button")) {
          choice.classList.toggle("is-active", choice === button);
        }
        selectReport(report);
      });
      switcher.append(button);
    }
    switcher.firstElementChild?.classList.add("is-active");
    toolbar.append(switcher);
  } else {
    const selector = document.createElement("select");
    selector.setAttribute("aria-label", "Select report");
    for (const report of reports) {
      selector.add(new Option(report.displayName, report.id));
    }
    selector.addEventListener("change", () => {
      const selected = reports.find((report) => report.id === selector.value);
      if (selected) {
        selectReport(selected);
      }
    });
    toolbar.append(selector);
  }

  const download = document.createElement("button");
  download.type = "button";
  download.className = "download-report";
  download.textContent = "Download .zip";
  download.addEventListener("click", () => {
    if (activeReport) {
      void downloadArchive(activeReport);
    }
  });
  toolbar.append(download);
  shell.append(toolbar);
  app.replaceChildren(shell);
  selectReport(reports[0]);
}

async function downloadAndOpen(report: BuildReport): Promise<void> {
  const sequence = ++loadSequence;
  showStatus(`Loading ${report.displayName}...`);
  try {
    const archive = reportCache.get(report.id) ?? (await report.download((progress) => showDownloadProgress(report.displayName, progress, sequence)));
    if (sequence === loadSequence) {
      openReport(report, archive);
      showStatus("");
    }
  } catch (error) {
    if (sequence === loadSequence) {
      showStatus(error instanceof Error ? error.message : "Unable to download report archive.");
    }
  }
}

async function downloadArchive(report: BuildReport): Promise<void> {
  try {
    showStatus(`Downloading ${report.displayName}...`);
    const archive = reportCache.get(report.id) ?? (await report.download((progress) => showDownloadProgress(report.displayName, progress)));
    remember(report.id, archive);
    const url = URL.createObjectURL(archive);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.displayName}.zip`;
    link.click();
    URL.revokeObjectURL(url);
    showStatus("");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "Unable to download report archive.");
  }
}

function showDownloadProgress(displayName: string, progress: DownloadProgress, sequence?: number): void {
  if (sequence !== undefined && sequence !== loadSequence) {
    return;
  }
  if (progress.total) {
    const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
    showStatus(`Loading ${displayName}: ${percent}%`);
    return;
  }
  showStatus(`Loading ${displayName}: ${formatBytes(progress.loaded)} downloaded`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function renderHostError(error: unknown): void {
  if (app) {
    app.textContent = error instanceof Error ? error.message : "Unable to load reports for this build.";
  }
}

function openReport(report: ReportDescriptor, archive: Blob): void {
  if (!app) {
    return;
  }
  remember(report.id, archive);
  activeReportId = report.id;
  reportFrame?.remove();
  reportFrame = document.createElement("iframe");
  reportFrame.className = "report-frame";
  reportFrame.title = report.displayName;
  reportFrame.src = new URL("./frame.html", import.meta.url).toString();
  reportFrame.addEventListener("load", () => {
    reportFrame?.contentWindow?.postMessage({ type: "load-report", report, archive, storage: readPersistedStorage(report.id) }, "*");
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
        if (activeReportId) {
          localStorage.setItem(storageKey(activeReportId, event.data.key), value);
        }
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

function readPersistedStorage(reportId: string): Record<string, string> {
  const storage: Record<string, string> = {};
  try {
    for (const key of PERSISTED_STORAGE_KEYS) {
      const value = localStorage.getItem(storageKey(reportId, key));
      if (value && new TextEncoder().encode(value).byteLength <= MAX_PERSISTED_STORAGE_BYTES) {
        storage[key] = value;
      }
    }
  } catch {
    // Storage is an optional convenience and must not break report rendering.
  }
  return storage;
}

function storageKey(reportId: string, key: string): string {
  return `html-report:${reportId}:${key}`;
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