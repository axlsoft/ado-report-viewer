export interface ReportDescriptor {
  id: string;
  displayName: string;
  entryPath: string;
}

export interface LoadReportMessage {
  type: "load-report";
  report: ReportDescriptor;
  archive: Blob;
  storage?: Record<string, string>;
}

export interface FrameStatusMessage {
  type: "frame-status";
  status: "ready" | "rendered" | "error";
  detail?: string;
}

export interface StorageReadMessage {
  type: "storage-read";
  key: string;
}

export interface StorageWriteMessage {
  type: "storage-write";
  key: string;
  value: string;
}

export type FrameToTabMessage = FrameStatusMessage | StorageReadMessage | StorageWriteMessage;

export function isLoadReportMessage(value: unknown): value is LoadReportMessage {
  if (!isRecord(value) || value.type !== "load-report" || !isRecord(value.report)) {
    return false;
  }

  return (
    value.archive instanceof Blob &&
    typeof value.report.id === "string" &&
    typeof value.report.displayName === "string" &&
    typeof value.report.entryPath === "string" &&
    (value.storage === undefined || isStringRecord(value.storage))
  );
}

export function isFrameToTabMessage(value: unknown): value is FrameToTabMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "frame-status") {
    return value.status === "ready" || value.status === "rendered" || value.status === "error";
  }

  return (
    (value.type === "storage-read" || value.type === "storage-write") &&
    typeof value.key === "string" &&
    (value.type === "storage-read" || typeof value.value === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}