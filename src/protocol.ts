export interface ReportDescriptor {
  id: string;
  displayName: string;
  entryPath: string;
}

/** Theme values for the frame's own messages. The tab receives the Azure DevOps theme; the frame does not. */
export interface FrameAppearance {
  accent: string;
  color: string;
  fontFamily: string;
}

export interface LoadReportMessage {
  type: "load-report";
  report: ReportDescriptor;
  archive: Blob;
  storage?: Record<string, string>;
  appearance?: FrameAppearance;
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
    (value.storage === undefined || isStringRecord(value.storage)) &&
    (value.appearance === undefined || isAppearance(value.appearance))
  );
}

function isAppearance(value: unknown): value is FrameAppearance {
  return isRecord(value) && typeof value.accent === "string" && typeof value.color === "string" && typeof value.fontFamily === "string";
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

// Messages between the report frame (virtual file server) and the sandboxed report document.

/** A resource sent with a rendered document. `css` holds stylesheet text whose references are tokens. */
export interface DocumentResource {
  token: string;
  blob: Blob;
  css?: string;
}

export interface RenderDocumentMessage {
  type: "render-document";
  html: string;
  resources: DocumentResource[];
}

export interface ResourceResponseMessage {
  type: "resource-response";
  id: string;
  blob?: Blob;
  error?: string;
}

export interface DocumentReadyMessage {
  type: "document-ready";
  search: string;
}

export interface ResourceRequestMessage {
  type: "resource-request";
  id: string;
  documentPath: string;
  reference: string;
}

export interface NavigateMessage {
  type: "navigate";
  documentPath: string;
  reference: string;
}

export type DocumentToFrameMessage = DocumentReadyMessage | ResourceRequestMessage | NavigateMessage | StorageWriteMessage;

export function isDocumentToFrameMessage(value: unknown): value is DocumentToFrameMessage {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case "document-ready":
      return typeof value.search === "string";
    case "resource-request":
      return typeof value.id === "string" && typeof value.documentPath === "string" && typeof value.reference === "string";
    case "navigate":
      return typeof value.documentPath === "string" && typeof value.reference === "string";
    case "storage-write":
      return typeof value.key === "string" && typeof value.value === "string";
    default:
      return false;
  }
}
