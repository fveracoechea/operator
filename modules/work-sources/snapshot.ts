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
  cleanupState: z.enum(["pending", "done", "failed", "kept"]).nullable(),
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

// A question is answered once, with the authority of its answer. Next actions show the unanswered.
const questionSchema = z.object({
  assignment: z.string(),
  key: z.string(),
  launchId: z.string(),
  question: z.string(),
  askedAt: z.string(),
  state: z.enum(["open", "awaiting_person", "answered", "withdrawn", "abandoned"]),
  answer: z.string().nullable(),
  answeredBy: z.enum(["super-agent", "person"]).nullable(),
  answeredAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type Question = z.infer<typeof questionSchema>;

/** An answer exists exactly when the question is answered, and only an ended question has an end. */
function validQuestion(question: Question) {
  const answered = question.state === "answered";
  const unanswered = question.state === "open" || question.state === "awaiting_person";
  return (
    (question.answer !== null) === answered &&
    (question.answeredBy !== null) === answered &&
    (question.answeredAt !== null) === answered &&
    (question.endedAt === null) === (answered || unanswered)
  );
}

/** An ended assignment leaves no question unanswered. */
function validQuestions(source: {
  assignments: { key: string; state: string }[];
  launches: { id: string; assignment: string }[];
  questions: Question[];
}) {
  return source.questions.every(
    (question) =>
      validQuestion(question) &&
      source.launches.some(
        (launch) => launch.assignment === question.assignment && launch.id === question.launchId,
      ) &&
      !(
        ["open", "awaiting_person"].includes(question.state) &&
        source.assignments.some(
          (row) =>
            row.key === question.assignment &&
            ["merged", "completed", "abandoned"].includes(row.state),
        )
      ),
  );
}

// A steering message waits on the worker while pending and on the SuperAgent while replied.
const messageSchema = z.object({
  assignment: z.string(),
  key: z.string(),
  launchId: z.string(),
  message: z.string(),
  questionKey: z.string().nullable(),
  sentAt: z.string(),
  state: z.enum(["pending", "acknowledged", "replied", "closed", "abandoned"]),
  rungAt: z.string().nullable(),
  doorbellFailure: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  reply: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type Message = z.infer<typeof messageSchema>;

/** Only an acknowledgement records its time, only a reply has text, and only an end has an end. */
function validMessage(message: Message) {
  const open = message.state === "pending" || message.state === "replied";
  return (
    (message.endedAt === null) === open &&
    (message.state !== "pending" || message.acknowledgedAt === null) &&
    (message.state !== "acknowledged" || message.acknowledgedAt !== null) &&
    (message.state !== "replied" || message.reply !== null) &&
    (message.reply === null || message.acknowledgedAt !== null) &&
    (message.state !== "acknowledged" || message.reply === null)
  );
}

/** A message belongs to a launch of its assignment, and an ended assignment leaves none open. */
function validMessages(source: {
  assignments: { key: string; state: string }[];
  launches: { id: string; assignment: string }[];
  messages: Message[];
}) {
  return source.messages.every(
    (message) =>
      validMessage(message) &&
      source.launches.some(
        (launch) => launch.assignment === message.assignment && launch.id === message.launchId,
      ) &&
      !(
        ["pending", "replied"].includes(message.state) &&
        source.assignments.some(
          (row) =>
            row.key === message.assignment &&
            ["merged", "completed", "abandoned"].includes(row.state),
        )
      ),
  );
}

/**
 * A report belongs to a report assignment and to one of its launches, and so do a question and a
 * message to their own assignment. A launch already shows that its assignment left the ready state.
 */
function validRecords(source: {
  assignments: { key: string; completion: string; state: string }[];
  launches: { id: string; assignment: string }[];
  reports: { assignment: string; launchId: string }[];
  questions: Question[];
  messages: Message[];
}) {
  return (
    validQuestions(source) &&
    validMessages(source) &&
    source.reports.every(
      (report) =>
        source.assignments.some(
          (row) => row.key === report.assignment && row.completion === "report",
        ) &&
        source.launches.some(
          (launch) => launch.assignment === report.assignment && launch.id === report.launchId,
        ),
    )
  );
}

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
    questions: z.array(questionSchema).parse(input.questions),
    messages: z.array(messageSchema).parse(input.messages),
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
  const validLifecycle =
    validLaunches &&
    validPullRequests &&
    validRecords(source) &&
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
