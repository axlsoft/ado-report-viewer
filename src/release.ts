// Classic release pipelines: which deployments of a release to read report attachments from, and how
// to label them. Kept free of the SDK so it can be unit tested.

interface ReleaseTaskResponse {
  name?: string;
  timelineRecordId?: string;
}

interface ReleaseDeployPhaseResponse {
  runPlanId?: string;
  deploymentJobs?: { job?: ReleaseTaskResponse; tasks?: ReleaseTaskResponse[] }[];
}

export interface ReleaseResponse {
  releaseDefinition?: { id: number };
  environments?: {
    id: number;
    name?: string;
    status?: string | number;
    deploySteps?: { attempt: number; status?: string | number; releaseDeployPhases?: ReleaseDeployPhaseResponse[] }[];
  }[];
}

/** One deployment phase whose plan can hold report attachments. */
export interface ReleasePlan {
  environmentId: number;
  attempt: number;
  planId: string;
}

export interface ReleaseLayout {
  plans: ReleasePlan[];
  /** Timeline record (task) ID → label of the stage, and job when the stage has several, that attached it. */
  jobNames: Map<string, string>;
}

/**
 * Lists the deployment phases of each stage's latest attempt, in stage order. A redeployment replaces
 * the stage's earlier reports, the way a new attempt replaces its logs on the release page. Stages that
 * never deployed have no attempts and are skipped.
 */
export function releaseLayout(release: ReleaseResponse): ReleaseLayout {
  const plans: ReleasePlan[] = [];
  const jobNames = new Map<string, string>();
  for (const environment of release.environments ?? []) {
    const latest = (environment.deploySteps ?? []).reduce<NonNullable<typeof environment.deploySteps>[number] | undefined>(
      (newest, step) => (newest === undefined || step.attempt > newest.attempt ? step : newest),
      undefined,
    );
    if (!latest) {
      continue;
    }
    const phases = latest.releaseDeployPhases ?? [];
    const jobs = phases.flatMap((phase) => phase.deploymentJobs ?? []);
    const stage = environment.name || `Stage ${environment.id}`;
    for (const job of jobs) {
      const label = jobs.length > 1 && job.job?.name ? `${stage} · ${job.job.name}` : stage;
      for (const task of job.tasks ?? []) {
        if (task.timelineRecordId) {
          jobNames.set(task.timelineRecordId, label);
        }
      }
    }
    for (const phase of phases) {
      if (phase.runPlanId && !plans.some((plan) => plan.planId === phase.runPlanId)) {
        plans.push({ environmentId: environment.id, attempt: latest.attempt, planId: phase.runPlanId });
      }
    }
  }
  return { plans, jobNames };
}

/** A stage that is deploying or queued to deploy may still attach reports. */
export function isReleaseInProgress(release: ReleaseResponse): boolean {
  // EnvironmentStatus serializes as camelCase strings; the numeric values are InProgress = 2 and Queued = 32.
  return (release.environments ?? []).some(({ status }) => status === "inProgress" || status === "queued" || status === 2 || status === 32);
}
