import * as SDK from "azure-devops-extension-sdk";
import { isReleaseInProgress, releaseLayout, type ReleaseResponse } from "./release";
import { decodeAttachmentName, disambiguateReports, type BuildReport, type DownloadProgress, type ReportList, type ReportSource } from "./reports";

const BUILD_RESOURCE_AREA_ID = "54572c7b-bbd3-45d4-80dc-28be08941620";
const RELEASE_RESOURCE_AREA_ID = "efc2f575-36ef-48e9-b672-0c6fb4a48ac5";
const BUILD_PAGE_DATA_SERVICE = "ms.vss-build-web.build-page-data-service";
const ATTACHMENT_TYPE = "html-report";
const API_VERSION = "7.1";
// The release task attachment routes are preview APIs; a preview version also works if they go GA.
const RELEASE_ATTACHMENTS_API_VERSION = "7.1-preview.1";
const RUN_CONTEXT_TIMEOUT_MS = 10_000;
// Get Attachment route: {project}/_apis/build/builds/{buildId}/{timelineId}/{recordId}/attachments/{type}/{name}
const ATTACHMENT_LINK = /\/builds\/\d+\/([\da-f-]{36})\/([\da-f-]{36})\/attachments\//iu;

interface BuildResultsConfiguration {
  buildId?: number | string;
  onBuildChanged?: (handler: (build: { id: number }) => void) => void;
}

interface ReleaseDetailsConfiguration {
  releaseId?: number | string;
  onReleaseChanged?: (handler: (release: { id: number }) => void) => void;
}

interface LocationService {
  getResourceAreaLocation(resourceAreaId: string): Promise<string | undefined>;
}

interface BuildPageDataService {
  getBuildPageData(): { build?: { id: number } } | undefined | Promise<{ build?: { id: number } } | undefined>;
}

interface BuildResponse {
  definition?: { id: number };
  status?: string | number;
}

interface AttachmentResponse {
  name: string;
  _links?: { self?: { href?: string } };
}

interface ReleaseAttachmentResponse {
  name: string;
  recordId?: string;
  timelineId?: string;
}

interface TimelineResponse {
  records?: { id: string; parentId?: string | null; type?: string; name?: string }[];
}

/**
 * Report source for the tab. The release summary tab (classic release pipelines) is recognized by its
 * `?view=release` contribution URI or its release configuration; every other host is a build run.
 */
export async function createAdoReportSource(): Promise<ReportSource> {
  const configuration = SDK.getConfiguration() as BuildResultsConfiguration & ReleaseDetailsConfiguration;
  const isRelease =
    new URLSearchParams(location.search).get("view") === "release" ||
    typeof configuration.onReleaseChanged === "function" ||
    configuration.releaseId !== undefined;
  return isRelease ? createReleaseReportSource(configuration) : createBuildReportSource(configuration);
}

/**
 * The build comes from the tab configuration's `onBuildChanged` (which also signals later updates),
 * its `buildId`, or the build page data service.
 */
async function createBuildReportSource(configuration: BuildResultsConfiguration): Promise<ReportSource> {
  const listeners: (() => void)[] = [];
  let buildId = validId(configuration.buildId);
  let resolveFirstBuild: (() => void) | undefined;
  const firstBuild = new Promise<void>((resolve) => (resolveFirstBuild = resolve));

  if (typeof configuration.onBuildChanged === "function") {
    // The host calls this once on registration, then again whenever the run updates (status, new
    // attachments, or a different run); every later call reloads the report list.
    let calls = 0;
    configuration.onBuildChanged((build) => {
      const changed = validId(build?.id);
      if (changed === undefined) {
        return;
      }
      buildId = changed;
      resolveFirstBuild?.();
      if (calls++ > 0) {
        listeners.forEach((listener) => listener());
      }
    });
  }
  if (buildId === undefined) {
    buildId = await buildIdFromPageData();
  }

  const projectId = currentProjectId();
  const baseUrl = await serviceUrl(BUILD_RESOURCE_AREA_ID, "dev.azure.com", "Build");
  const projectUrl = `${baseUrl}${encodeURIComponent(projectId)}/_apis/build/builds`;

  return {
    onChange: (listener) => listeners.push(listener),
    load: async () => {
      if (buildId === undefined) {
        await Promise.race([firstBuild, delay(RUN_CONTEXT_TIMEOUT_MS)]);
      }
      if (buildId === undefined) {
        throw new Error("This tab could not determine which pipeline run to show.");
      }
      return loadReports(projectUrl, projectId, buildId);
    },
  };
}

/**
 * Report source for the release summary tab. The release comes from the configuration's `releaseId`
 * or `onReleaseChanged`, which also signals updates such as a stage starting or finishing.
 */
async function createReleaseReportSource(configuration: ReleaseDetailsConfiguration): Promise<ReportSource> {
  const listeners: (() => void)[] = [];
  let releaseId = validId(configuration.releaseId);
  let loadStarted = false;
  let resolveFirstRelease: (() => void) | undefined;
  const firstRelease = new Promise<void>((resolve) => (resolveFirstRelease = resolve));

  if (typeof configuration.onReleaseChanged === "function") {
    configuration.onReleaseChanged((release) => {
      const changed = validId(release?.id);
      if (changed === undefined) {
        return;
      }
      releaseId = changed;
      resolveFirstRelease?.();
      // A call during registration, before the first load, has nothing to refresh.
      if (loadStarted) {
        listeners.forEach((listener) => listener());
      }
    });
  }

  const projectId = currentProjectId();
  const baseUrl = await serviceUrl(RELEASE_RESOURCE_AREA_ID, "vsrm.dev.azure.com", "Release");
  const projectUrl = `${baseUrl}${encodeURIComponent(projectId)}/_apis/release/releases`;

  return {
    onChange: (listener) => listeners.push(listener),
    load: async () => {
      loadStarted = true;
      if (releaseId === undefined) {
        await Promise.race([firstRelease, delay(RUN_CONTEXT_TIMEOUT_MS)]);
      }
      if (releaseId === undefined) {
        throw new Error("This tab could not determine which release to show.");
      }
      return loadReleaseReports(projectUrl, projectId, releaseId);
    },
  };
}

async function loadReleaseReports(projectUrl: string, projectId: string, releaseId: number): Promise<ReportList> {
  const releaseUrl = `${projectUrl}/${releaseId}`;
  const release = await getJson<ReleaseResponse>(releaseUrl, "load the release");
  const { plans, jobNames } = releaseLayout(release);
  const definitionId = release.releaseDefinition?.id;
  const pipelineScope = definitionId === undefined ? `release-${releaseId}` : `release-definition-${definitionId}`;

  const perPlan = await Promise.all(
    plans.map(async ({ environmentId, attempt, planId }) => {
      const planUrl = `${releaseUrl}/environments/${environmentId}/attempts/${attempt}/plan/${encodeURIComponent(planId)}`;
      const attachments = await getJson<{ value: ReleaseAttachmentResponse[] }>(
        `${planUrl}/attachments/${ATTACHMENT_TYPE}`,
        "list report attachments",
        RELEASE_ATTACHMENTS_API_VERSION,
        { notFound: { value: [] } },
      );
      return attachments.value.flatMap((attachment) => {
        const metadata = decodeAttachmentName(attachment.name);
        if (!metadata || !attachment.timelineId || !attachment.recordId) {
          return [];
        }
        const downloadUrl =
          `${planUrl}/timelines/${encodeURIComponent(attachment.timelineId)}/records/${encodeURIComponent(attachment.recordId)}` +
          `/attachments/${ATTACHMENT_TYPE}/${encodeURIComponent(attachment.name)}`;
        return [
          {
            id: `release-${releaseId}/${environmentId}/${attempt}/${attachment.recordId}/${attachment.name}`,
            displayName: metadata.name,
            entryPath: metadata.entryPath,
            jobName: jobNames.get(attachment.recordId),
            storageScope: `${pipelineScope}:${metadata.name}`,
            download: (onProgress) => downloadAttachment(downloadUrl, onProgress, RELEASE_ATTACHMENTS_API_VERSION),
          } satisfies BuildReport,
        ];
      });
    }),
  );

  return {
    reports: disambiguateReports(perPlan.flat()),
    inProgress: isReleaseInProgress(release),
    pipelineKey: `${projectId}:${pipelineScope}`,
  };
}

async function loadReports(projectUrl: string, projectId: string, buildId: number): Promise<ReportList> {
  const buildUrl = `${projectUrl}/${buildId}`;
  const [build, attachments] = await Promise.all([
    getJson<BuildResponse>(buildUrl, "load the pipeline run"),
    getJson<{ value: AttachmentResponse[] }>(`${buildUrl}/attachments/${ATTACHMENT_TYPE}`, "list report attachments"),
  ]);
  const definitionId = build.definition?.id;
  const pipelineScope = definitionId === undefined ? `build-${buildId}` : `pipeline-${definitionId}`;

  const parsed = attachments.value.flatMap((attachment) => {
    const metadata = decodeAttachmentName(attachment.name);
    const link = ATTACHMENT_LINK.exec(attachment._links?.self?.href ?? "");
    if (!metadata || !link) {
      return [];
    }
    const [, timelineId, recordId] = link;
    return [{ attachment, metadata, recordId, downloadUrl: `${buildUrl}/${timelineId}/${recordId}/attachments/${ATTACHMENT_TYPE}/${encodeURIComponent(attachment.name)}` }];
  });

  const names = parsed.map(({ metadata }) => metadata.name);
  const jobNames = names.length === new Set(names).size ? new Map<string, string>() : await jobNamesByRecord(buildUrl);

  const reports = parsed.map(({ attachment, metadata, recordId, downloadUrl }): BuildReport => ({
    id: `${buildId}/${recordId}/${attachment.name}`,
    displayName: metadata.name,
    entryPath: metadata.entryPath,
    jobName: jobNames.get(recordId),
    storageScope: `${pipelineScope}:${metadata.name}`,
    download: (onProgress) => downloadAttachment(downloadUrl, onProgress),
  }));

  return {
    reports: disambiguateReports(reports),
    inProgress: !isCompleted(build.status),
    pipelineKey: `${projectId}:${pipelineScope}`,
  };
}

/** Maps each timeline record to the name of the job containing it (attachments come from task records). */
async function jobNamesByRecord(buildUrl: string): Promise<Map<string, string>> {
  const timeline = await getJson<TimelineResponse>(`${buildUrl}/timeline`, "load the run timeline").catch(() => ({ records: [] }));
  const records = new Map((timeline.records ?? []).map((record) => [record.id, record]));
  const jobNames = new Map<string, string>();
  for (const record of records.values()) {
    let current: typeof record | undefined = record;
    for (let depth = 0; current && depth < 10; depth += 1) {
      if (current.type === "Job" && current.name) {
        jobNames.set(record.id, current.name);
        break;
      }
      current = current.parentId ? records.get(current.parentId) : undefined;
    }
  }
  return jobNames;
}

function isCompleted(status: string | number | undefined): boolean {
  // The REST API serializes BuildStatus as a camelCase string; the numeric value of Completed is 2.
  return status === "completed" || status === 2;
}

async function getJson<T>(url: string, action: string, apiVersion = API_VERSION, options: { notFound?: T } = {}): Promise<T> {
  const response = await fetch(`${url}?api-version=${apiVersion}`, { headers: await authorization() });
  if (response.status === 404 && options.notFound !== undefined) {
    return options.notFound;
  }
  if (!response.ok) {
    throw new Error(`Unable to ${action} (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

async function authorization(): Promise<HeadersInit> {
  // Requested per call: access tokens expire, and a tab can stay open for a long run.
  return { Authorization: `Bearer ${await SDK.getAccessToken()}` };
}

async function buildIdFromPageData(): Promise<number | undefined> {
  try {
    const service = await SDK.getService<BuildPageDataService>(BUILD_PAGE_DATA_SERVICE);
    return validId((await service.getBuildPageData())?.build?.id);
  } catch {
    return undefined;
  }
}

function validId(value: unknown): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function currentProjectId(): string {
  const context = SDK.getWebContext();
  if (!context.project?.id) {
    throw new Error("The report tab requires a project context.");
  }
  return context.project.id;
}

/** Base URL of a service (resource area), ending with `/`; on Azure DevOps Services it defaults to `https://<hostedDomain>/<org>/`. */
async function serviceUrl(resourceAreaId: string, hostedDomain: string, serviceName: string): Promise<string> {
  const locationService = await SDK.getService<LocationService>("ms.vss-web.location-service");
  const host = SDK.getHost();
  const hosted = host.isHosted && host.name ? `https://${hostedDomain}/${encodeURIComponent(host.name)}` : undefined;
  const baseUrl = (await locationService?.getResourceAreaLocation(resourceAreaId)) ?? hosted;
  if (!baseUrl) {
    throw new Error(`The Azure DevOps ${serviceName} service location is unavailable.`);
  }
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function downloadAttachment(url: string, onProgress?: (progress: DownloadProgress) => void, apiVersion = API_VERSION): Promise<Blob> {
  const response = await fetch(`${url}?api-version=${apiVersion}`, { headers: await authorization() });
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
  return new Blob(chunks, { type: "application/zip" });
}
