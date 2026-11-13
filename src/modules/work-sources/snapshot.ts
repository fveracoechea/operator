import { z } from "zod";
import type { DeviceState } from "../device-state/main.ts";
import { storedPlanSchema } from "./plan.ts";
import { assignmentStateSchema, type AssignmentState } from "./assignment-machine.ts";
import { decideSource } from "./source-machine.ts";
import { Obligations } from "../obligations/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

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
  kind: z
    .string()
    .nullable()
    .transform((text) =>
      text === null ? null : WorkerKinds.snapshotSchema().parse(JSON.parse(text)),
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
  // The resolved internal review value of this start. Older releases recorded none.
  internalReview: z.boolean().nullable(),
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

// The internal review and its handoff. ADR-0020.
const internalReviewSchema = z.object({
  assignment: z.string(),
  state: z.enum(["reviewing", "ready", "skipped"]),
  implementerLaunchId: z.string(),
  handoffState: z.enum(["pending", "failed", "done"]),
  handoffDetail: z.string().nullable(),
  handoffRunning: z.boolean(),
  startedAt: z.string(),
  updatedAt: z.string(),
  // The PR head that the review ended at, and the summary comment of a ready end.
  readyHead: z.string().nullable(),
  commentUrl: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type InternalReview = z.infer<typeof internalReviewSchema>;

export const findingSchema = z.strictObject({
  axis: z.enum(["Spec", "Standards", "Skills"]),
  severity: z.enum(["blocker", "nice-to-have"]),
  location: z.string().trim().min(1),
  claim: z.string().trim().min(1),
});
export type Finding = z.infer<typeof findingSchema>;

const roundSchema = z.object({
  assignment: z.string(),
  number: z.number().int().positive(),
  launchId: z.string(),
  head: z.string(),
  findings: z.string().transform((text) => z.array(findingSchema).parse(JSON.parse(text))),
  recordedAt: z.string(),
});
export type InternalReviewRound = z.infer<typeof roundSchema>;

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

// What the SuperAgent owes the person. Next actions show the open ones. ADR-0026.
const obligationSchema = z
  .object({
    key: z.string(),
    kind: z.enum(Obligations.kinds()),
    summary: z.string(),
    reference: z.string().nullable(),
    openedAt: z.string(),
    state: z.enum(Obligations.states()),
    closedAt: z.string().nullable(),
  })
  // Only a closed obligation has an end.
  .refine((row) => (row.state === "closed") === (row.closedAt !== null));
export type Obligation = z.infer<typeof obligationSchema>;

/** Only an associated PR records an internal review, from one of its assignment's launches. */
function reviewsConsistent(source: {
  launches: Launch[];
  pullRequests: PullRequest[];
  internalReviews: InternalReview[];
  internalReviewRounds: InternalReviewRound[];
}) {
  return (
    source.internalReviews.every(
      (review) =>
        source.pullRequests.some((pr) => pr.assignment === review.assignment) &&
        source.launches.some(
          (launch) =>
            launch.assignment === review.assignment && launch.id === review.implementerLaunchId,
        ),
    ) &&
    source.internalReviewRounds.every((round) =>
      source.internalReviews.some((review) => review.assignment === round.assignment),
    )
  );
}

/**
 * A report belongs to a report assignment and to one of its launches, and so do a question and a
 * message to their own assignment. A launch already shows that its assignment left the ready state.
 */
function validRecords(
  source: {
    assignments: { key: string; completion: string; state: string }[];
    launches: Launch[];
    reports: { assignment: string; launchId: string }[];
    questions: Question[];
    messages: Message[];
  } & Parameters<typeof reviewsConsistent>[0],
) {
  return (
    validQuestions(source) &&
    validMessages(source) &&
    reviewsConsistent(source) &&
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

const promotionSchema = z.object({
  assignment: z.string(),
  report: z.string(),
  reportNumber: z.number().int().positive(),
  trackerKey: z.string(),
  instructions: z.string(),
  branch: z.string(),
  internalReview: z.boolean().nullable(),
  worktreePath: z.string(),
  handoverLaunchId: z.string().nullable(),
  promotedAt: z.string(),
});
export type Promotion = z.infer<typeof promotionSchema>;
type Plan = z.infer<typeof storedPlanSchema>;

/**
 * The registered plan stays unchanged. A promoted PR assignment joins it with the accepted
 * report as its only dependency, and keeps the report assignment's start profile. ADR-0023.
 */
function withPromotions(plan: Plan, promotions: Promotion[]) {
  return [
    ...plan.assignments.map((assignment) => ({ ...assignment, promotion: null })),
    ...promotions.map((promotion) => ({
      key: promotion.assignment,
      trackerKey: promotion.trackerKey,
      instructions: promotion.instructions,
      // The promoted work answers the report's intent and keeps its start profile.
      intent: plan.assignments.find((row) => row.key === promotion.report)?.intent,
      profile: plan.assignments.find((row) => row.key === promotion.report)?.profile,
      dependencies: [promotion.report],
      completion: "pr" as const,
      kind: null,
      resources: "worktree" as const,
      branch: promotion.branch,
      internalReview: promotion.internalReview ?? undefined,
      promotion,
    })),
  ];
}

/** Each stored assignment row matches one registered or promoted assignment. */
function sameAssignments(
  rows: AssignmentState[],
  assignments: { key: string; completion: string }[],
) {
  return (
    rows.length === assignments.length &&
    assignments.every((assignment) =>
      rows.some((row) => row.key === assignment.key && row.completion === assignment.completion),
    )
  );
}

/** A promoted report is a completed report assignment with that accepted report. */
function promotionsValid(
  source: { assignments: AssignmentState[]; reports: Report[] },
  promotions: Promotion[],
) {
  return promotions.every(
    (promotion) =>
      source.assignments.some(
        (row) =>
          row.key === promotion.report && row.completion === "report" && row.state === "completed",
      ) &&
      source.reports.some(
        (report) =>
          report.assignment === promotion.report &&
          report.number === promotion.reportNumber &&
          report.decision === "accepted",
      ),
  );
}

export function decodeSource(input: StoredSource) {
  const source = {
    ...input.source,
    state: z.enum(["open", "finished", "reset"]).parse(input.source.state),
    plan: storedPlanSchema.parse(JSON.parse(input.source.plan)),
    assignments: z.array(assignmentStateSchema).parse(input.assignments),
    launches: z.array(launchSchema).parse(input.launches),
    pullRequests: z.array(pullRequestSchema).parse(input.pullRequests),
    reports: z.array(reportSchema).parse(input.reports),
    cleanups: z.array(cleanupSchema).parse(input.cleanups),
    internalReviews: z.array(internalReviewSchema).parse(input.internalReviews),
    internalReviewRounds: z.array(roundSchema).parse(input.internalReviewRounds),
    questions: z.array(questionSchema).parse(input.questions),
    messages: z.array(messageSchema).parse(input.messages),
    obligations: z.array(obligationSchema).parse(input.obligations),
  };
  const promotions = z.array(promotionSchema).parse(input.promotions);
  const assignments = withPromotions(source.plan, promotions);
  const consistent =
    source.trackerKey === source.plan.trackerKey &&
    sameAssignments(source.assignments, assignments);
  const validPromotions = promotionsValid(source, promotions);
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
    validPromotions &&
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
  source.assignments = assignments.map((assignment) =>
    assignmentStateSchema.parse(input.assignments.find((row) => row.key === assignment.key)),
  );
  const stored = new Map(input.assignments.map((row) => [row.key, row]));
  return {
    ...source,
    planned: assignments.map((assignment) => ({
      ...assignment,
      kind: z.enum(WorkerKinds.names()).nullable().parse(stored.get(assignment.key)?.kind),
    })),
  };
}
