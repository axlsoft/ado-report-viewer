import * as SDK from "azure-devops-extension-sdk";
import { createAdoReportSource } from "./ado";
import { isFrameToTabMessage, type ReportDescriptor } from "./protocol";
import type { BuildReport, DownloadProgress, ReportList, ReportSource } from "./reports";
import "./styles.css";

const MAX_CACHED_REPORTS = 3;
const MAX_PERSISTED_STORAGE_BYTES = 16 * 1024;
const PERSISTED_STORAGE_KEYS = new Set(["theme", "filters"]);
// onBuildChanged is the primary refresh signal; polling covers attachments added without one.
const IN_PROGRESS_POLL_MS = 30_000;
const app = document.querySelector<HTMLElement>("#app");
const reportCache = new Map<string, Blob>();
// Downloads in progress, shared so a report requested again before it arrives is downloaded once.
const pendingDownloads = new Map<string, Promise<Blob>>();
let reportFrame: HTMLIFrameElement | undefined;
let activeReport: BuildReport | undefined;
let renderedReportIds = "";
let loadSequence = 0;
let refreshSequence = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

void initialize();

async function initialize(): Promise<void> {
  let source: ReportSource | undefined;
  try {
    if (window.parent === window) {
      source =
        import.meta.env.DEV || import.meta.env.VITE_REPORT_HARNESS === "1"
          ? await import("./harness").then(({ createHarnessReportSource }) => createHarnessReportSource())
          : undefined;
      if (!source) {
        renderFilePicker();
        return;
      }
    } else {
      await SDK.init({ applyTheme: true, loaded: false });
      // Notify early so the host never shows its spinner while reports download.
      SDK.notifyLoadSucceeded();
      source = await createAdoReportSource();
    }
  } catch (error) {
    renderMessage(error instanceof Error ? error.message : "Unable to load reports for this run.", "error");
    return;
  }
  const reportSource = source;
  reportSource.onChange(() => void refresh(reportSource));
  await refresh(reportSource);
}

async function refresh(source: ReportSource): Promise<void> {
  const sequence = ++refreshSequence;
  clearTimeout(pollTimer);
  let list: ReportList;
  try {
    list = await source.load();
  } catch (error) {
    if (sequence === refreshSequence) {
      renderMessage(error instanceof Error ? error.message : "Unable to load reports for this run.", "error");
    }
    return;
  }
  if (sequence !== refreshSequence) {
    return;
  }
  renderReports(list);
  if (list.inProgress) {
    pollTimer = setTimeout(() => void refresh(source), IN_PROGRESS_POLL_MS);
  }
}

function renderReports(list: ReportList): void {
  if (!app) {
    return;
  }
  if (list.reports.length === 0) {
    renderMessage(
      list.inProgress
        ? "This run is still in progress. Reports appear here once they are attached."
        : "No HTML reports are attached to this run. Use pipeline-templates/publish-html-report.yml to attach one.",
      list.inProgress ? "in-progress" : "empty",
    );
    return;
  }

  const shell = ensureShell();
  const note = shell.querySelector<HTMLElement>(".run-note");
  if (note) {
    note.hidden = !list.inProgress;
  }

  // Refreshes that return the same reports keep the toolbar and the open report untouched.
  const ids = list.reports.map((report) => `${report.id}\u0000${report.displayName}`).join("\u0001");
  if (ids === renderedReportIds) {
    return;
  }
  renderedReportIds = ids;

  const remembered = readSelection(list.pipelineKey);
  const selected =
    list.reports.find((report) => report.id === activeReport?.id) ??
    list.reports.find((report) => report.displayName === remembered) ??
    list.reports[0];
  renderSwitcher(shell, list, selected);
  if (selected.id !== activeReport?.id || !reportFrame) {
    void downloadAndOpen(selected);
  }
}

function ensureShell(): HTMLElement {
  const existing = app?.querySelector<HTMLElement>(".report-shell");
  if (existing || !app) {
    return existing as HTMLElement;
  }
  const shell = document.createElement("section");
  shell.className = "report-shell";
  const toolbar = document.createElement("header");
  toolbar.className = "report-toolbar";
  const choices = document.createElement("div");
  choices.className = "report-choices";
  const note = document.createElement("span");
  note.className = "run-note";
  note.textContent = "Run in progress: more reports may appear.";
  note.hidden = true;
  const download = document.createElement("button");
  download.type = "button";
  download.className = "download-report";
  download.textContent = "Download .zip";
  download.addEventListener("click", () => {
    if (activeReport) {
      void downloadArchive(activeReport);
    }
  });
  toolbar.append(choices, note, download);
  shell.append(toolbar);
  app.replaceChildren(shell);
  return shell;
}

function renderSwitcher(shell: HTMLElement, list: ReportList, selected: BuildReport): void {
  const choices = shell.querySelector<HTMLElement>(".report-choices");
  if (!choices) {
    return;
  }
  const choose = (report: BuildReport): void => {
    writeSelection(list.pipelineKey, report.displayName);
    void downloadAndOpen(report);
  };

  if (list.reports.length <= 4) {
    const switcher = document.createElement("div");
    switcher.className = "report-switcher";
    switcher.setAttribute("role", "group");
    switcher.setAttribute("aria-label", "Select report");
    for (const report of list.reports) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = report.displayName;
      button.title = report.displayName;
      button.className = "report-choice";
      button.classList.toggle("is-active", report.id === selected.id);
      button.setAttribute("aria-pressed", String(report.id === selected.id));
      button.addEventListener("click", () => {
        for (const choice of switcher.querySelectorAll<HTMLButtonElement>("button")) {
          choice.classList.toggle("is-active", choice === button);
          choice.setAttribute("aria-pressed", String(choice === button));
        }
        choose(report);
      });
      switcher.append(button);
    }
    choices.replaceChildren(switcher);
    return;
  }

  const selector = document.createElement("select");
  selector.setAttribute("aria-label", "Select report");
  for (const report of list.reports) {
    selector.add(new Option(report.displayName, report.id, false, report.id === selected.id));
  }
  selector.addEventListener("change", () => {
    const report = list.reports.find((candidate) => candidate.id === selector.value);
    if (report) {
      choose(report);
    }
  });
  choices.replaceChildren(selector);
}

async function downloadAndOpen(report: BuildReport): Promise<void> {
  const sequence = ++loadSequence;
  activeReport = report;
  showStatus(`Loading ${report.displayName}...`);
  try {
    const archive = await archiveFor(report);
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
    const archive = await archiveFor(report);
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

/** The report's archive: from the cache, from a download already in progress, or downloaded now. */
function archiveFor(report: BuildReport): Promise<Blob> {
  const cached = reportCache.get(report.id);
  if (cached) {
    return Promise.resolve(cached);
  }
  let pending = pendingDownloads.get(report.id);
  if (!pending) {
    pending = report
      .download((progress) => showDownloadProgress(report, progress))
      .then((archive) => {
        remember(report.id, archive);
        return archive;
      })
      .finally(() => pendingDownloads.delete(report.id));
    pendingDownloads.set(report.id, pending);
  }
  return pending;
}

function showDownloadProgress(report: BuildReport, progress: DownloadProgress): void {
  // A shared download reports progress only while its report is the one being shown.
  if (activeReport?.id !== report.id) {
    return;
  }
  if (progress.total) {
    const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
    showStatus(`Loading ${report.displayName}: ${percent}%`);
    return;
  }
  showStatus(`Loading ${report.displayName}: ${formatBytes(progress.loaded)} downloaded`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Local fallback without fixtures: open any report ZIP from disk. */
function renderFilePicker(): void {
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
      activeReport = {
        id: archive.name,
        displayName: archive.name,
        entryPath: "index.html",
        storageScope: archive.name,
        download: async () => archive,
      };
      openReport(activeReport, archive);
    }
  });
  toolbar.append(picker);
  shell.append(toolbar);
  app.replaceChildren(shell);
}

function renderMessage(text: string, kind: "empty" | "error" | "in-progress"): void {
  if (!app) {
    return;
  }
  reportFrame = undefined;
  activeReport = undefined;
  renderedReportIds = "";
  const message = document.createElement("p");
  message.className = `tab-message is-${kind}`;
  if (kind === "error") {
    message.setAttribute("role", "alert");
  }
  message.textContent = text;
  app.replaceChildren(message);
}

function openReport(report: BuildReport, archive: Blob): void {
  const shell = app?.querySelector(".report-shell");
  if (!shell) {
    return;
  }
  remember(report.id, archive);
  reportFrame?.remove();
  reportFrame = document.createElement("iframe");
  reportFrame.className = "report-frame";
  reportFrame.title = report.displayName;
  reportFrame.src = new URL("frame.html", document.baseURI).href;
  // Send only cloneable descriptor fields; a BuildReport also carries its download function.
  const descriptor: ReportDescriptor = { id: report.id, displayName: report.displayName, entryPath: report.entryPath };
  const storage = readPersistedStorage(report.storageScope);
  reportFrame.addEventListener("load", () => {
    reportFrame?.contentWindow?.postMessage({ type: "load-report", report: descriptor, archive, storage }, "*");
  });
  reportFrame.addEventListener("error", () => showStatus("Unable to load the report frame."));
  shell.append(reportFrame);
}

window.addEventListener("message", (event) => {
  if (event.source !== reportFrame?.contentWindow || !isFrameToTabMessage(event.data)) {
    return;
  }
  if (event.data.type === "frame-status") {
    showStatus(event.data.status === "error" ? (event.data.detail ?? "Unable to render report.") : "");
  }
  if (event.data.type === "storage-write" && PERSISTED_STORAGE_KEYS.has(event.data.key) && activeReport) {
    const value = event.data.value;
    if (new TextEncoder().encode(value).byteLength <= MAX_PERSISTED_STORAGE_BYTES) {
      safeStorage(() => localStorage.setItem(storageKey(activeReport?.storageScope ?? "", event.data.key), value));
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

function readPersistedStorage(scope: string): Record<string, string> {
  const storage: Record<string, string> = {};
  safeStorage(() => {
    for (const key of PERSISTED_STORAGE_KEYS) {
      const value = localStorage.getItem(storageKey(scope, key));
      if (value && new TextEncoder().encode(value).byteLength <= MAX_PERSISTED_STORAGE_BYTES) {
        storage[key] = value;
      }
    }
  });
  return storage;
}

function storageKey(scope: string, key: string): string {
  return `html-report:${scope}:${key}`;
}

function readSelection(pipelineKey: string | undefined): string | undefined {
  return pipelineKey ? (safeStorage(() => localStorage.getItem(`html-report-selection:${pipelineKey}`)) ?? undefined) : undefined;
}

function writeSelection(pipelineKey: string | undefined, displayName: string): void {
  if (pipelineKey) {
    safeStorage(() => localStorage.setItem(`html-report-selection:${pipelineKey}`, displayName));
  }
}

/** Storage is an optional convenience; failures (quota, disabled storage) must not break the tab. */
function safeStorage<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
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
    status.className = "tab-status";
    status.textContent = message;
    app.prepend(status);
  }
}
