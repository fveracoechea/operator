import { Err, Ok, type Result } from "unthrown";
import type { AssignmentState } from "./assignment-machine.ts";
import { complete } from "./source-machine.ts";

export type ReportCommand = "submit" | "resume" | "accept" | "return" | "cleanup";
type Pane = { socket: string | null; paneId: string | null };
type Facts = {
  command: ReportCommand;
  assignment: { key: string; completion: string; state: string };
  assignments: AssignmentState[];
  launch: { id: string; state: string; paneId: string | null; herdrSocket: string | null } | null;
  latest: { number: number; decision: string | null; cleanupState: string | null } | null;
  /** The pane that runs the command, when Herdr supplies one. */
  caller: Pane;
};
type ReportTransition = {
  assignmentState?: "running" | "reported" | "completed";
  sourceFinished?: boolean;
  finishLaunch?: string;
  /** Insert report `number`, or update the latest report. */
  report: { insert: number } | { update: number; decision?: "accepted" | "returned" };
  cleanup?: "pending";
  retry?: boolean;
};
type Refusal = { reason: string; detail: string };

function refuse(reason: string, detail: string) {
  return Err<Refusal>({ reason, detail: `${detail} Nothing changed.` });
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

function submit(facts: Facts): Result<ReportTransition, Refusal> {
  const { assignment, launch, latest } = facts;
  if (assignment.state === "reported")
    return refuse(
      "report_awaiting_decision",
      `Report ${latest?.number ?? 0} of ${assignment.key} awaits the SuperAgent's decision.`,
    );
  if (assignment.state !== "running" || launch?.state !== "running")
    return refuse(
      "assignment_not_running",
      `Assignment ${assignment.key} has no running worker launch.`,
    );
  return Ok({ assignmentState: "reported", report: { insert: (latest?.number ?? 0) + 1 } });
}

function accept(facts: Facts): Result<ReportTransition, Refusal> {
  const { assignment, launch, latest } = facts;
  if (latest === null) return refuse("report_not_submitted", `${assignment.key} has no report.`);
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

const rules: Record<ReportCommand, (facts: Facts) => Result<ReportTransition, Refusal>> = {
  submit,
  accept,
  resume({ assignment, launch, latest }) {
    return assignment.state === "reported" &&
      latest?.decision === "returned" &&
      launch?.state === "running"
      ? Ok({ assignmentState: "running", report: { update: latest.number } })
      : refuse(
          "report_not_returned",
          `${assignment.key} has no returned report for this running worker.`,
        );
  },
  return({ assignment, latest }) {
    return assignment.state === "reported" && latest?.decision === null
      ? Ok({ report: { update: latest.number, decision: "returned" } })
      : refuse(
          "report_not_submitted",
          `${assignment.key} has no submitted report that awaits a decision.`,
        );
  },
  cleanup({ assignment, latest }) {
    return assignment.state === "completed" && latest?.decision === "accepted"
      ? Ok({ report: { update: latest.number } })
      : refuse("report_not_accepted", `${assignment.key} has no accepted report.`);
  },
};

/**
 * Submission is the worker's step and needs a running launch. Only the supervising SuperAgent
 * accepts or returns, never from the worker's pane. Submission does not unblock dependents.
 */
export function decideReport(facts: Facts): Result<ReportTransition, Refusal> {
  if (facts.assignment.completion !== "report")
    return refuse("assignment_not_report", `${facts.assignment.key} completes through a PR.`);
  if ((facts.command === "accept" || facts.command === "return") && selfDecision(facts))
    return refuse(
      "self_decision_refused",
      "A WorkerAgent cannot accept or return its own report. The supervising SuperAgent decides from its own pane.",
    );
  return rules[facts.command](facts);
}
