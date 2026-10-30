import { disambiguateReports, type BuildReport, type ReportList, type ReportSource } from "./reports";

interface FixtureArchive {
  entry: string;
  id: string;
  name: string;
  path: string;
}

declare global {
  interface Window {
    /** Harness control for E2E tests: finishes the simulated run of the `in-progress` scenario. */
    completeHarnessRun?: () => void;
  }
}

/**
 * Dev-only stand-in for the Azure DevOps report source. Fixture archives are served by the Vite dev
 * or preview server, and each report flows through the same tab, frame, and sandbox code as
 * production. `?scenario=` simulates run states:
 * - `in-progress`: the run starts with one report; `window.completeHarnessRun()` completes it.
 * - `empty`: a completed run without reports.
 * - `matrix`: duplicate report names from matrix jobs.
 */
export async function createHarnessReportSource(): Promise<ReportSource | undefined> {
  const response = await fetch("/__fixtures/manifest.json");
  if (!response.ok) {
    return undefined;
  }
  const { archives } = (await response.json()) as { archives: FixtureArchive[] };
  const scenario = new URLSearchParams(location.search).get("scenario") ?? "completed";
  const listeners: (() => void)[] = [];
  let completed = scenario !== "in-progress";
  window.completeHarnessRun = () => {
    completed = true;
    listeners.forEach((listener) => listener());
  };

  return {
    onChange: (listener) => listeners.push(listener),
    load: async (): Promise<ReportList> => {
      let reports: BuildReport[];
      if (scenario === "empty") {
        reports = [];
      } else if (scenario === "matrix") {
        const site = archives.find((archive) => archive.id === "static-report");
        const coverage = archives.find((archive) => archive.id === "lcov-report");
        reports = disambiguateReports(
          [
            site && fixtureReport(site, "linux", { jobName: "Linux" }),
            site && fixtureReport(site, "windows", { jobName: "Windows" }),
            coverage && fixtureReport(coverage, "a", { name: "Coverage" }),
            coverage && fixtureReport(coverage, "b", { name: "Coverage" }),
          ].filter((report) => report !== undefined),
        );
      } else {
        reports = (completed ? archives : archives.slice(0, 1)).map((archive) => fixtureReport(archive));
      }
      return { reports, inProgress: !completed, pipelineKey: `harness:${scenario}` };
    },
  };
}

function fixtureReport(archive: FixtureArchive, instance = "", overrides: { jobName?: string; name?: string } = {}): BuildReport {
  return {
    id: instance ? `${archive.id}/${instance}` : archive.id,
    displayName: overrides.name ?? archive.name,
    entryPath: archive.entry,
    jobName: overrides.jobName,
    storageScope: archive.id,
    download: async () => {
      const download = await fetch(`/__fixtures/${encodeURIComponent(archive.path)}`);
      if (!download.ok) {
        throw new Error(`Unable to download report archive (HTTP ${download.status}).`);
      }
      return download.blob();
    },
  };
}
