import type { ReportDescriptor } from "./protocol";

export interface DownloadProgress {
  loaded: number;
  total?: number;
}

export interface BuildReport extends ReportDescriptor {
  /** Stable across runs of the same pipeline; namespaces persisted report storage. */
  storageScope: string;
  /** Name of the pipeline job that attached the report, used to tell duplicates apart. */
  jobName?: string;
  download(onProgress?: (progress: DownloadProgress) => void): Promise<Blob>;
}

export interface ReportList {
  reports: BuildReport[];
  /** The run has not finished, so more reports may still be attached. */
  inProgress: boolean;
  /** Identifies the pipeline, for remembering the selected report across runs. */
  pipelineKey?: string;
}

/** Where the tab gets its reports: Azure DevOps when hosted, fixtures in the local harness. */
export interface ReportSource {
  load(): Promise<ReportList>;
  /** Called when the run changes (for example, it completes) and the list should be reloaded. */
  onChange(listener: () => void): void;
}

/**
 * Labels reports that share a display name (typically matrix jobs) with their job name, and numbers
 * any that are still ambiguous. Unique names are left unchanged.
 */
export function disambiguateReports<T extends Pick<BuildReport, "displayName" | "jobName">>(reports: readonly T[]): T[] {
  const countByName = countBy(reports.map((report) => report.displayName));
  const labeled = reports.map((report) =>
    countByName.get(report.displayName) === 1 || !report.jobName ? report : { ...report, displayName: `${report.displayName} · ${report.jobName}` },
  );

  const countByLabel = countBy(labeled.map((report) => report.displayName));
  const seen = new Map<string, number>();
  return labeled.map((report) => {
    if (countByLabel.get(report.displayName) === 1) {
      return report;
    }
    const index = (seen.get(report.displayName) ?? 0) + 1;
    seen.set(report.displayName, index);
    return { ...report, displayName: `${report.displayName} (${index})` };
  });
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** Decodes `html-report-v1-<base64url(display name, NUL, entry path)>` (see the pipeline template). */
export function decodeAttachmentName(name: string): { entryPath: string; name: string } | undefined {
  const match = /^html-report-v1-([A-Za-z0-9_-]+)$/u.exec(name);
  if (!match) {
    return undefined;
  }
  try {
    const padded = match[1].replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(match[1].length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const [displayName, entryPath, extra] = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0");
    return displayName && entryPath && extra === undefined ? { name: displayName, entryPath } : undefined;
  } catch {
    return undefined;
  }
}
