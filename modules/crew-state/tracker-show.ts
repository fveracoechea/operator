import { TrackerUpdate } from "../tracker-update/main.ts";
import { readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  observationsOf,
  readBinding,
  type TrackerBinding,
  type TrackerOperationRow,
  TRACKER_STEPS,
  type TrackerStep,
  targetOf,
  trackerOperationsOf,
  writeAttemptsOf,
} from "./tracker.ts";
import { storedProblems } from "./tracker-input.ts";

type Shared = StateFailure | RequestFailure;

type MapRead = Extract<Awaited<ReturnType<typeof TrackerUpdate.readMap>>, { status: "read" }>;

type StepState = {
  step: TrackerStep;
  /** Whether this step applies at all. A source with no map issue has no amendment to write. */
  applicable: boolean;
  operationId: string | null;
  state: string;
  reason: string;
  problems: Array<{ reason: string; detail: string }>;
  resourceId: string | null;
  resourceUrl: string | null;
  revision: number | null;
  writeAttempts: number;
  observations: number;
  nextActions: string[];
};

export type TrackerStepsReport = {
  assignmentId: string;
  provider: string;
  repository: string;
  issue: number;
  mapIssue: number | null;
  steps: StepState[];
  /** True only when every applicable step is verified. */
  complete: boolean;
  incomplete: TrackerStep[];
};

export type TrackerStepsResult =
  | { status: "reported"; report: TrackerStepsReport }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "tracker-unbound"; assignmentId: string; detail: string }
  | { status: "unsupported-provider"; provider: string }
  | Shared;

/** What a caller may do next about one step. No exit code alone authorizes any of these. */
function nextActionsFor(request: {
  step: TrackerStep;
  applicable: boolean;
  operation: TrackerOperationRow | null;
}): string[] {
  if (!request.applicable) {
    return [];
  }
  if (request.operation === null) {
    return ["operator tracker record"];
  }

  const { state } = request.operation;
  if (state === "verified") {
    return [];
  }
  if (state === "conflict") {
    return ["bring the recorded links and differences to the user"];
  }
  if (state === "uncertain") {
    return [
      "operator tracker recover",
      "operator approval grant for tracker.additional_write, then operator tracker record --approval",
    ];
  }
  if (state === "failed") {
    return ["operator tracker record"];
  }

  return ["operator tracker recover", "operator tracker record"];
}

/**
 * Reports the three steps of one assignment's tracker update.
 * Each step carries its own outcome, so a verified step stays usable while another is blocked,
 * and nothing here writes anything.
 */
export async function showTrackerSteps(request: {
  projectRoot: string;
  assignmentId: string;
}): Promise<TrackerStepsResult> {
  const read = await readState(request.projectRoot, (db) => {
    const bound = readBinding(db, request.assignmentId);
    if (bound.status === "unknown-assignment" || bound.status === "tracker-unbound") {
      return bound;
    }
    if (bound.status === "unsupported-provider") {
      return { status: "unsupported-provider" as const, provider: bound.provider };
    }

    const held = trackerOperationsOf(db, request.assignmentId);
    const binding: TrackerBinding = bound.binding;
    const steps = TRACKER_STEPS.map((step) => {
      const operation = held.find((one) => one.step === step) ?? null;
      const applicable = targetOf(binding, step) !== null;
      return {
        step,
        applicable,
        operationId: operation?.id ?? null,
        state: operation?.state ?? "unrecorded",
        reason: operation?.reason ?? "tracker.pending",
        problems: operation === null ? [] : storedProblems(operation.problems),
        resourceId: operation?.resourceId ?? null,
        resourceUrl: operation?.resourceUrl ?? null,
        revision: operation?.revision ?? null,
        writeAttempts: operation === null ? 0 : writeAttemptsOf(db, operation.id).length,
        observations: operation === null ? 0 : observationsOf(db, operation.id).length,
        nextActions: nextActionsFor({ step, applicable, operation }),
      } satisfies StepState;
    });

    const incomplete = steps
      .filter((one) => one.applicable && one.state !== "verified")
      .map((one) => one.step);

    return {
      status: "reported" as const,
      report: {
        assignmentId: request.assignmentId,
        provider: binding.provider,
        repository: binding.repository,
        issue: binding.issue,
        mapIssue: binding.mapIssue,
        steps,
        complete: incomplete.length === 0,
        incomplete,
      },
    };
  });

  return read;
}

export type TrackerMapResult =
  | {
      status: "read";
      repository: string;
      issue: number;
      reading: MapRead["reading"];
      verdict: MapRead["verdict"];
    }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "tracker-unbound"; assignmentId: string; detail: string }
  | { status: "unsupported-provider"; provider: string }
  | { status: "map-target-missing"; assignmentId: string; sourceId: string }
  | { status: "unreadable"; detail: string }
  | Shared;

/**
 * Reads the canonical map of one assignment's source: the baseline body plus every amendment.
 * A session reads this before it selects map-dependent work, so an incomplete scan and a
 * conflict both arrive as reasons to stop.
 */
export async function readTrackerMap(request: {
  projectRoot: string;
  assignmentId: string;
}): Promise<TrackerMapResult> {
  const read = await readState(request.projectRoot, (db) => {
    const bound = readBinding(db, request.assignmentId);
    if (bound.status === "unknown-assignment" || bound.status === "tracker-unbound") {
      return bound;
    }
    if (bound.status === "unsupported-provider") {
      return { status: "unsupported-provider" as const, provider: bound.provider };
    }

    const target = targetOf(bound.binding, "map_amendment");
    return target === null
      ? {
          status: "map-target-missing" as const,
          assignmentId: request.assignmentId,
          sourceId: bound.binding.sourceId,
        }
      : { status: "ok" as const, provider: bound.binding.provider, target };
  });

  if (read.status !== "ok") {
    return read;
  }

  const reading = await TrackerUpdate.readMap({ provider: read.provider, target: read.target });
  if (reading.status === "unsupported-provider") {
    return { status: "unsupported-provider", provider: reading.provider };
  }
  if (reading.status === "unreadable") {
    return reading;
  }

  return {
    status: "read",
    repository: read.target.repository,
    issue: read.target.issue,
    reading: reading.reading,
    verdict: reading.verdict,
  };
}
