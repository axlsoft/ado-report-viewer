import { describe, expect, it } from "vitest";
import { isReleaseInProgress, releaseLayout, type ReleaseResponse } from "../../src/release";

const job = (name: string, ...taskIds: string[]) => ({ job: { name }, tasks: taskIds.map((timelineRecordId) => ({ timelineRecordId })) });

describe("releaseLayout", () => {
  it("reads each stage's latest attempt in stage order and skips stages that never deployed", () => {
    const release: ReleaseResponse = {
      environments: [
        {
          id: 1,
          name: "QA",
          deploySteps: [
            { attempt: 2, releaseDeployPhases: [{ runPlanId: "plan-qa-2", deploymentJobs: [job("Agent job", "qa-2")] }] },
            { attempt: 1, releaseDeployPhases: [{ runPlanId: "plan-qa-1", deploymentJobs: [job("Agent job", "qa-1")] }] },
          ],
        },
        { id: 2, name: "Prod", deploySteps: [] },
        { id: 3, name: "Perf", deploySteps: [{ attempt: 1, releaseDeployPhases: [{ runPlanId: "plan-perf", deploymentJobs: [job("Agent job", "perf")] }] }] },
      ],
    };

    const { plans, jobNames } = releaseLayout(release);

    expect(plans).toEqual([
      { environmentId: 1, attempt: 2, planId: "plan-qa-2" },
      { environmentId: 3, attempt: 1, planId: "plan-perf" },
    ]);
    expect(Object.fromEntries(jobNames)).toEqual({ "qa-2": "QA", perf: "Perf" });
  });

  it("adds the job name when a stage has several jobs, and lists each plan once", () => {
    const release: ReleaseResponse = {
      environments: [
        {
          id: 1,
          name: "QA",
          deploySteps: [
            {
              attempt: 1,
              releaseDeployPhases: [
                { runPlanId: "plan", deploymentJobs: [job("Linux", "a"), job("Windows", "b")] },
                { runPlanId: "plan", deploymentJobs: [] },
                { deploymentJobs: [] },
              ],
            },
          ],
        },
      ],
    };

    const { plans, jobNames } = releaseLayout(release);

    expect(plans).toEqual([{ environmentId: 1, attempt: 1, planId: "plan" }]);
    expect(Object.fromEntries(jobNames)).toEqual({ a: "QA · Linux", b: "QA · Windows" });
  });

  it("handles a release without stages", () => {
    expect(releaseLayout({})).toEqual({ plans: [], jobNames: new Map() });
  });
});

describe("isReleaseInProgress", () => {
  it("is true while a stage is deploying or queued", () => {
    expect(isReleaseInProgress({ environments: [{ id: 1, status: "succeeded" }, { id: 2, status: "inProgress" }] })).toBe(true);
    expect(isReleaseInProgress({ environments: [{ id: 1, status: "queued" }] })).toBe(true);
    expect(isReleaseInProgress({ environments: [{ id: 1, status: 2 }] })).toBe(true);
  });

  it("is false when no stage is running, including stages waiting on a schedule", () => {
    expect(isReleaseInProgress({ environments: [{ id: 1, status: "succeeded" }, { id: 2, status: "notStarted" }, { id: 3, status: "scheduled" }] })).toBe(false);
    expect(isReleaseInProgress({})).toBe(false);
  });
});
