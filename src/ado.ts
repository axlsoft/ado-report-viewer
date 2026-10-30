import * as SDK from "azure-devops-extension-sdk";
import type { ReportDescriptor } from "./protocol";

const BUILD_RESOURCE_AREA_ID = "54572c7b-bbd3-45d4-80dc-28be08941620";
const ATTACHMENT_TYPE = "html-report";
const API_VERSION = "7.1";

interface LocationService {
  getResourceAreaLocation(resourceAreaId: string): Promise<string | undefined>;
}

interface BuildAttachment {
  name: string;
}

interface AttachmentListResponse {
  value: BuildAttachment[];
}

export interface BuildReport extends ReportDescriptor {
  download(onProgress?: (progress: DownloadProgress) => void): Promise<Blob>;
}

export interface DownloadProgress {
  loaded: number;
  total?: number;
}

export async function listBuildReports(): Promise<BuildReport[]> {
  const configuration = SDK.getConfiguration() as { buildId?: number | string };
  const buildId = Number(configuration.buildId);
  if (!Number.isSafeInteger(buildId) || buildId <= 0) {
    return [];
  }

  const context = SDK.getWebContext();
  if (!context.project?.id) {
    throw new Error("The report tab requires a project build context.");
  }
  const locationService = await SDK.getService<LocationService>("ms.vss-web.location-service");
  const baseUrl = await locationService.getResourceAreaLocation(BUILD_RESOURCE_AREA_ID);
  if (!baseUrl) {
    throw new Error("The Azure DevOps Build service location is unavailable.");
  }

  const collectionUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const endpoint = `${collectionUrl}${encodeURIComponent(context.project.id)}/_apis/build/builds/${buildId}/attachments/${ATTACHMENT_TYPE}`;
  const token = await SDK.getAccessToken();
  const response = await fetch(`${endpoint}?api-version=${API_VERSION}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Unable to list report attachments (HTTP ${response.status}).`);
  }

  const attachments = (await response.json()) as AttachmentListResponse;
  return attachments.value.flatMap((attachment) => {
    const metadata = decodeAttachmentName(attachment.name);
    if (!metadata) {
      return [];
    }
    return [
      {
        id: attachment.name,
        displayName: metadata.name,
        entryPath: metadata.entryPath,
        download: () => downloadAttachment(endpoint, attachment.name, token),
      },
    ];
  });
}

async function downloadAttachment(
  endpoint: string,
  name: string,
  token: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<Blob> {
  const response = await fetch(`${endpoint}/${encodeURIComponent(name)}?api-version=${API_VERSION}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Unable to download report archive (HTTP ${response.status}).`);
  }
  if (!response.body) {
    const archive = await response.blob();
    onProgress?.({ loaded: archive.size, total: archive.size });
    return archive;
  }

  const totalHeader = response.headers.get("content-length");
  const total = totalHeader && /^\d+$/u.test(totalHeader) ? Number(totalHeader) : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = new Uint8Array(value);
      chunks.push(chunk);
      loaded += chunk.byteLength;
      onProgress?.({ loaded, total });
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([bytes], { type: response.headers.get("content-type") ?? "application/zip" });
}

function decodeAttachmentName(name: string): { entryPath: string; name: string } | undefined {
  const match = /^html-report-v1-([A-Za-z0-9_-]+)$/u.exec(name);
  if (!match) {
    return undefined;
  }
  try {
    const padded = match[1].replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(match[1].length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const [displayName, entryPath, extra] = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0");
    return displayName && entryPath && !extra ? { name: displayName, entryPath } : undefined;
  } catch {
    return undefined;
  }
}