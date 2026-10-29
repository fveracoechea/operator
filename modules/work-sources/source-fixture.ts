import type { DeviceState } from "../device-state/main.ts";

type Stored = Extract<ReturnType<typeof DeviceState.readSources>, { tag: "Ok" }>["value"][number];
type Planned = {
  key: string;
  completion: "pr" | "report";
  state: string;
  dependencies?: string[];
};

export const sourceId = "one";

/** Stored rows of one source in `example/one`. Each planned assignment gets its stored state. */
export function storedSource(
  planned: Planned[],
  rows: Partial<Omit<Stored, "source" | "assignments">> & {
    state?: string;
    endedAt?: string | null;
  } = {},
): Stored {
  return {
    source: {
      id: sourceId,
      repository: "example/one",
      trackerKey: "APP-1",
      state: rows.state ?? "open",
      registeredAt: "2026-01-01T00:00:00.000Z",
      endedAt: rows.endedAt ?? null,
      plan: JSON.stringify({
        trackerKey: "APP-1",
        assignments: planned.map((row) => {
          const base = {
            key: row.key,
            trackerKey: `APP-${row.key}`,
            instructions: `Do ${row.key}.`,
            completion: row.completion,
            dependencies: row.dependencies ?? [],
          };
          return row.completion === "pr"
            ? { ...base, resources: "worktree", branch: `task/${row.key}` }
            : { ...base, resources: "pane" };
        }),
      }),
    },
    assignments: planned.map((row) => ({
      sourceId,
      key: row.key,
      completion: row.completion,
      state: row.state,
    })),
    launches: rows.launches ?? [],
    pullRequests: rows.pullRequests ?? [],
    reports: rows.reports ?? [],
    cleanups: rows.cleanups ?? [],
  };
}

export function storedLaunch(
  assignment: string,
  change: Partial<Stored["launches"][number]> = {},
): Stored["launches"][number] {
  return {
    id: `l-${assignment}`,
    sourceId,
    assignment,
    attempt: 1,
    state: "running",
    name: `worker-${assignment}`,
    resources: "pane",
    branch: null,
    host: "opencode",
    model: "test/model",
    requestedModel: "test/model",
    reasoningEffort: "medium",
    profile: null,
    release: JSON.stringify({ version: "1.0.0" }),
    skills: "[]",
    herdrSocket: "/herdr.sock",
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: `w1:${assignment}`,
    worktreePath: null,
    worktreeWorkspaceId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    failureReason: null,
    failureDetail: null,
    activity: null,
    activityAt: null,
    ownerPid: null,
    leaseAt: null,
    abandoned: false,
    ...change,
  };
}

export function storedPullRequest(
  assignment: string,
  change: Partial<Stored["pullRequests"][number]> = {},
): Stored["pullRequests"][number] {
  return {
    sourceId,
    assignment,
    repository: "example/one",
    number: 7,
    url: "https://github.com/example/one/pull/7",
    branch: `task/${assignment}`,
    associatedAt: "2026-01-02T00:00:00.000Z",
    progress: "{}",
    waitState: "idle",
    waitAt: null,
    waitOwnerPid: null,
    waitLeaseAt: null,
    mergedHead: null,
    mergeCommit: null,
    mergedAt: null,
    relay: null,
    waitStopped: false,
    ...change,
  };
}

export function storedReport(
  assignment: string,
  change: Partial<Stored["reports"][number]> = {},
): Stored["reports"][number] {
  return {
    sourceId,
    assignment,
    number: 1,
    launchId: `l-${assignment}`,
    submittedAt: "2026-01-03T00:00:00.000Z",
    conclusion: `${assignment} done.`,
    evidence: JSON.stringify(["a.ts:1"]),
    unresolved: JSON.stringify([`Gap of ${assignment}.`]),
    decisions: "[]",
    files: "[]",
    decision: null,
    decidedAt: null,
    followUp: null,
    cleanupState: null,
    cleanupDetail: null,
    ...change,
  };
}

export function storedCleanup(
  assignment: string,
  change: Partial<Stored["cleanups"][number]> = {},
): Stored["cleanups"][number] {
  return {
    sourceId,
    assignment,
    launchId: `l-${assignment}`,
    step: null,
    state: "done",
    reason: null,
    detail: null,
    updatedAt: "2026-01-04T00:00:00.000Z",
    ownerPid: null,
    leaseAt: null,
    running: false,
    ...change,
  };
}
