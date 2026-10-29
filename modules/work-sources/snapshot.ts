import { z } from "zod";
import type { DeviceState } from "../device-state/main.ts";
import { planSchema } from "./plan.ts";
import { assignmentStateSchema } from "./assignment-machine.ts";
import { decideSource } from "./source-machine.ts";

type StoredSource = Extract<
  ReturnType<typeof DeviceState.readSources>,
  { tag: "Ok" }
>["value"][number];

const launchSchema = z.object({
  id: z.string(),
  assignment: z.string(),
  attempt: z.number().int().positive(),
  state: z.enum(["starting", "running", "failed", "interrupted", "finished"]),
  name: z.string(),
  resources: z.enum(["pane", "worktree"]),
  branch: z.string().nullable(),
  host: z.enum(["opencode", "claude-code"]),
  model: z.string(),
  reasoningEffort: z.string(),
  profile: z.string().nullable(),
  release: z
    .string()
    .transform((text) => z.object({ version: z.string() }).loose().parse(JSON.parse(text))),
  skills: z
    .string()
    .transform((text) =>
      z.array(z.object({ name: z.string(), identity: z.string() })).parse(JSON.parse(text)),
    ),
  workspaceId: z.string().nullable(),
  tabId: z.string().nullable(),
  paneId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  worktreeWorkspaceId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  failureDetail: z.string().nullable(),
  activity: z.string().nullable(),
  activityAt: z.string().nullable(),
  abandoned: z.boolean(),
});
export type Launch = z.infer<typeof launchSchema>;

// The wait progress belongs to the PR feedback loop. Next actions read only its wait state.
const pullRequestSchema = z.object({
  assignment: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  branch: z.string(),
  associatedAt: z.string(),
  waitState: z.enum(["idle", "waiting", "reported", "timed_out", "not_open"]),
  waitAt: z.string().nullable(),
  waitStopped: z.boolean(),
  mergedHead: z.string().nullable(),
  mergeCommit: z.string().nullable(),
  mergedAt: z.string().nullable(),
  // The stack parent and relay state. The relay's Git progress belongs to the PR feedback loop.
  relay: z
    .string()
    .nullable()
    .transform((text) =>
      text === null
        ? null
        : z
            .object({
              parent: z.object({ assignment: z.string(), number: z.number(), branch: z.string() }),
              state: z.enum(["stacked", "blocked", "relayed"]),
              blocker: z.object({ reason: z.string(), detail: z.string() }).nullable(),
            })
            .parse(JSON.parse(text)),
    ),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

const textList = z.string().transform((text) => z.array(z.string()).parse(JSON.parse(text)));
const reportSchema = z.object({
  assignment: z.string(),
  number: z.number().int().positive(),
  launchId: z.string(),
  submittedAt: z.string(),
  conclusion: z.string(),
  evidence: textList,
  unresolved: textList,
  decisions: z.string().transform((text) =>
    z
      .array(
        z.object({
          question: z.string(),
          answer: z.string(),
          by: z.enum(["person", "super-agent"]),
        }),
      )
      .parse(JSON.parse(text)),
  ),
  files: textList,
  decision: z.enum(["accepted", "returned"]).nullable(),
  decidedAt: z.string().nullable(),
  followUp: z.string().nullable(),
  cleanupState: z.enum(["pending", "done", "failed"]).nullable(),
  cleanupDetail: z.string().nullable(),
});
export type Report = z.infer<typeof reportSchema>;
// A verified merge records its ordered cleanup. Next actions read where it stopped.
const cleanupSchema = z.object({
  assignment: z.string(),
  step: z.enum(["remote_branch", "pane", "worktree"]).nullable(),
  state: z.enum(["pending", "failed", "blocked", "done"]),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  updatedAt: z.string(),
  running: z.boolean(),
});
export type Cleanup = z.infer<typeof cleanupSchema>;

export function decodeSource(input: StoredSource) {
  const source = {
    ...input.source,
    state: z.enum(["open", "finished", "reset"]).parse(input.source.state),
    plan: planSchema.parse(JSON.parse(input.source.plan)),
    assignments: z.array(assignmentStateSchema).parse(input.assignments),
    launches: z.array(launchSchema).parse(input.launches),
    pullRequests: z.array(pullRequestSchema).parse(input.pullRequests),
    reports: z.array(reportSchema).parse(input.reports),
    cleanups: z.array(cleanupSchema).parse(input.cleanups),
  };
  const consistent =
    source.trackerKey === source.plan.trackerKey &&
    source.assignments.length === source.plan.assignments.length &&
    source.plan.assignments.every((assignment) =>
      source.assignments.some(
        (row) => row.key === assignment.key && row.completion === assignment.completion,
      ),
    );
  const expected = decideSource({ state: "open", assignments: source.assignments });
  const validState =
    source.state === "reset"
      ? source.assignments.every((assignment) =>
          ["merged", "completed", "abandoned"].includes(assignment.state),
        )
      : source.state === expected;
  // A launch always belongs to an assignment that left the ready state.
  const validLaunches = source.launches.every((launch) =>
    source.assignments.some((row) => row.key === launch.assignment && row.state !== "ready"),
  );
  // A PR open assignment has its PR, and only a PR assignment that left running has one.
  const validPullRequests =
    source.assignments.every(
      (row) =>
        row.state !== "pr-open" || source.pullRequests.some((pr) => pr.assignment === row.key),
    ) &&
    source.pullRequests.every((pr) =>
      source.assignments.some(
        (row) =>
          row.key === pr.assignment &&
          row.completion === "pr" &&
          ["pr-open", "merged", "abandoned"].includes(row.state),
      ),
    );
  // Only a verified merge ends a PR assignment as merged, and it always records its cleanup.
  // Report work has no PR, so it can have neither.
  const validMerges =
    source.assignments.every((row) => {
      const pr = source.pullRequests.find((item) => item.assignment === row.key);
      const merged = pr !== undefined && pr.mergedHead !== null && pr.mergeCommit !== null;
      const cleanup = source.cleanups.some((item) => item.assignment === row.key);
      return row.state === "merged" ? merged && cleanup : !merged && !cleanup;
    }) &&
    source.cleanups.every(
      (cleanup) =>
        (cleanup.step === null) === (cleanup.state === "done") &&
        source.assignments.some((row) => row.key === cleanup.assignment),
    );
  // A report belongs to a report assignment and to one of its launches. A launch already shows
  // that its assignment left the ready state.
  const validReports = source.reports.every(
    (report) =>
      source.assignments.some(
        (row) => row.key === report.assignment && row.completion === "report",
      ) &&
      source.launches.some(
        (launch) => launch.assignment === report.assignment && launch.id === report.launchId,
      ),
  );
  const validLifecycle =
    validLaunches &&
    validPullRequests &&
    validReports &&
    validMerges &&
    validState &&
    (source.state === "open" ? source.endedAt === null : source.endedAt !== null);
  if (!consistent || !validLifecycle) {
    // oxlint-disable-next-line unthrown/no-throw -- The read boundary reports malformed persisted data as corruption without repair.
    throw new z.ZodError([
      { code: "custom", path: [], message: "Source rows do not match the supplied plan." },
    ]);
  }
  source.assignments = source.plan.assignments.map((assignment) =>
    assignmentStateSchema.parse(input.assignments.find((row) => row.key === assignment.key)),
  );
  return source;
}
