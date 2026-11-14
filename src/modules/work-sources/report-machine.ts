import { Err, Ok, type Result } from "unthrown";
import type { AssignmentState } from "./assignment-machine.ts";
import { complete } from "./source-machine.ts";
import type { ResultContext } from "../../lib/cli-result.ts";

export type ReportCommand = "submit" | "resume" | "accept" | "promote" | "return" | "cleanup";
type Pane = { socket: string | null; paneId: string | null };
type Facts = {
  command: ReportCommand;
  assignment: { key: string; completion: string; state: string };
  assignments: AssignmentState[];
  launch: {
    id: string;
    state: string;
    paneId: string | null;
    herdrSocket: string | null;
    worktreePath?: string | null;
  } | null;
  latest: { number: number; decision: string | null; cleanupState: string | null } | null;
  /** The pane that runs the command, when Herdr supplies one. */
  caller: Pane;
  /** The source state and the key of the PR assignment that a promotion adds. ADR-0023. */
  promotion?: { sourceState: string; key: string };
};
type ReportTransition = {
  assignmentState?: "running" | "reported" | "completed";
  sourceFinished?: boolean;
  finishLaunch?: string;
  /** Insert report `number`, or update the latest report. */
  report: { insert: number } | { update: number; decision?: "accepted" | "returned" };
  cleanup?: "pending";
  retry?: boolean;
  /** The PR assignment that takes over the report's worktree and, while it runs, its worker. */
  promote?: { key: string };
};
type Refusal = ResultContext & { reason: string; detail: string };

function refuse(reason: string, detail: string, context: ResultContext = {}) {
  return Err<Refusal>({
    reason,
    detail: `${detail} Nothing changed.`,
    next: { command: "operator next", why: "Read the current report action before retrying." },
    ...context,
  });
}

/** The worker's own pane cannot accept or return its report. */
function selfDecision(facts: Facts) {
  const { launch, caller } = facts;
  return (
    launch !== null &&
    launch.paneId !== null &&
    caller.paneId === launch.paneId &&
    caller.socket === launch.herdrSocket
  );
}

function submittedReport(facts: Facts): Result<ReportTransition, Refusal> {
  const { assignment, latest } = facts;
  // A returned report stays reported until the worker resumes with the follow-up.
  if (latest?.decision === "returned")
    return refuse(
      "report_returned",
      `Report ${latest.number} of ${assignment.key} was returned. Run operator report resume first.`,
      {
        next: {
          command: "operator report resume",
          why: "Read the returned report's follow-up before submitting again.",
        },
        state: { assignment: assignment.state, decision: latest.decision },
      },
    );
  return refuse(
    "report_awaiting_decision",
    `Report ${latest?.number ?? 0} of ${assignment.key} awaits the SuperAgent's decision.`,
    {
      next: {
        decider: "super-agent",
        question: "Does the submitted report meet the assignment, or must it be returned?",
      },
      state: { assignment: assignment.state, decision: latest?.decision ?? null },
    },
  );
}

function submit(facts: Facts): Result<ReportTransition, Refusal> {
  const { assignment, launch, latest } = facts;
  if (assignment.state === "reported") return submittedReport(facts);
  if (assignment.state !== "running" || launch?.state !== "running")
    return refuse(
      "assignment_not_running",
      `Assignment ${assignment.key} has no running worker launch.`,
      { state: { assignment: assignment.state, launch: launch?.state ?? null } },
    );
  return Ok({ assignmentState: "reported", report: { insert: (latest?.number ?? 0) + 1 } });
}

function accept(facts: Facts): Result<ReportTransition, Refusal> {
  const { assignment, launch, latest } = facts;
  if (latest === null)
    return refuse("report_not_submitted", `${assignment.key} has no report.`, {
      state: { report: null },
    });
  // A repeated acceptance retries the cleanup that an earlier acceptance did not finish.
  if (
    assignment.state === "completed" &&
    latest.decision === "accepted" &&
    latest.cleanupState !== "done"
  )
    return Ok({ report: { update: latest.number }, cleanup: "pending", retry: true });
  if (assignment.state !== "reported" || latest.decision !== null)
    return refuse(
      "report_not_submitted",
      `${assignment.key} has no submitted report that awaits a decision.`,
      { state: { assignment: assignment.state, decision: latest.decision } },
    );
  // The accepted assignment becomes complete, so the source finishes when all other work is.
  return Ok({
    assignmentState: "completed",
    sourceFinished: facts.assignments.filter((row) => row.key !== assignment.key).every(complete),
    finishLaunch: launch?.state === "running" ? launch.id : undefined,
    report: { update: latest.number, decision: "accepted" },
    cleanup: "pending",
  });
}

/**
 * Acceptance that also adds one PR assignment. The source stays open for it, and the report's
 * pane and worktree stay, because the PR assignment owns them. ADR-0023.
 */
function promote(facts: Facts): Result<ReportTransition, Refusal> {
  const { promotion } = facts;
  const sourceState = promotion?.sourceState ?? null;
  if (sourceState !== "open" || promotion === undefined)
    return refuse("source_ended", `The source is ${sourceState ?? "unknown"}.`, {
      state: { source: sourceState },
    });
  return promoteReport(facts, promotion);
}

function promoteReport(
  facts: Facts,
  promotion: NonNullable<Facts["promotion"]>,
): Result<ReportTransition, Refusal> {
  const { assignment, assignments, launch, latest } = facts;
  // A missing report has no decision to compare, so it is refused too.
  if (assignment.state !== "reported" || latest?.decision !== null)
    return refuse(
      "report_not_submitted",
      `${assignment.key} has no submitted report that awaits a decision. A report is promoted at most once.`,
      { state: { assignment: assignment.state, decision: latest?.decision ?? null } },
    );
  if (launch === null || (launch.worktreePath ?? null) === null)
    return refuse(
      "promotion_worktree_missing",
      `${assignment.key} has no worktree, so read-only report work has nothing to reuse. Accept it and register a new source instead.`,
      {
        next: {
          decider: "super-agent",
          question:
            "Should the report be accepted without promotion and a new source registered instead?",
        },
        state: { worktree: null },
      },
    );
  if (assignments.some((row) => row.key === promotion.key))
    return refuse(
      "promotion_key_taken",
      `Assignment ${promotion.key} already exists in this source.`,
      {
        next: {
          decider: "super-agent",
          question: "Which unused assignment key should the promotion plan use?",
        },
        state: { assignmentExists: true },
      },
    );
  return Ok({
    assignmentState: "completed",
    sourceFinished: false,
    finishLaunch: launch.state === "running" ? launch.id : undefined,
    report: { update: latest.number, decision: "accepted" },
    promote: { key: promotion.key },
  });
}

const rules: Record<ReportCommand, (facts: Facts) => Result<ReportTransition, Refusal>> = {
  submit,
  accept,
  promote,
  resume({ assignment, launch, latest }) {
    return assignment.state === "reported" &&
      latest?.decision === "returned" &&
      launch?.state === "running"
      ? Ok({ assignmentState: "running", report: { update: latest.number } })
      : refuse(
          "report_not_returned",
          `${assignment.key} has no returned report for this running worker.`,
          {
            state: {
              assignment: assignment.state,
              decision: latest?.decision ?? null,
              launch: launch?.state ?? null,
            },
          },
        );
  },
  return({ assignment, latest }) {
    return assignment.state === "reported" && latest?.decision === null
      ? Ok({ report: { update: latest.number, decision: "returned" } })
      : refuse(
          "report_not_submitted",
          `${assignment.key} has no submitted report that awaits a decision.`,
          { state: { assignment: assignment.state, decision: latest?.decision ?? null } },
        );
  },
  cleanup({ assignment, latest }) {
    return assignment.state === "completed" && latest?.decision === "accepted"
      ? Ok({ report: { update: latest.number } })
      : refuse("report_not_accepted", `${assignment.key} has no accepted report.`, {
          state: { assignment: assignment.state, decision: latest?.decision ?? null },
        });
  },
};

/**
 * Submission is the worker's step and needs a running launch. Only the supervising SuperAgent
 * accepts or returns, never from the worker's pane. Submission does not unblock dependents.
 */
export function decideReport(facts: Facts): Result<ReportTransition, Refusal> {
  if (facts.assignment.completion !== "report")
    return refuse("assignment_not_report", `${facts.assignment.key} completes through a PR.`, {
      next: {
        decider: "super-agent",
        question:
          "Which report assignment should this command target? The selected assignment completes through a PR.",
      },
      state: { completion: facts.assignment.completion },
    });
  if (["accept", "promote", "return"].includes(facts.command) && selfDecision(facts))
    return refuse(
      "self_decision_refused",
      "A WorkerAgent cannot accept or return its own report. The supervising SuperAgent decides from its own pane.",
      {
        next: {
          decider: "super-agent",
          question: "What is your decision from your own supervising pane?",
        },
        state: { samePane: true, sameServer: true },
      },
    );
  return rules[facts.command](facts);
}
