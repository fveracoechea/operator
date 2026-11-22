import { z } from "zod";
import { CommitReview } from "../commit-review/main.ts";

export const assignmentStateSchema = z.discriminatedUnion("completion", [
  z.object({
    key: z.string(),
    completion: z.literal("commit"),
    state: z.enum(["ready", "running", "completed", "abandoned"]),
  }),
  z.object({
    key: z.string(),
    completion: z.literal("pr"),
    state: z.enum(["ready", "running", "pr-open", "merged", "abandoned"]),
  }),
  z.object({
    key: z.string(),
    completion: z.literal("report"),
    state: z.enum(["ready", "running", "reported", "completed", "abandoned"]),
  }),
]);
export type AssignmentState = z.infer<typeof assignmentStateSchema>;
type Facts = {
  assignment: AssignmentState;
  dependencies: AssignmentState[];
  launch?: "starting" | "abandoned" | "running" | "failed" | "interrupted" | "finished";
  pullRequest?: "idle" | "waiting" | "stopped" | "reported" | "timed_out" | "not_open";
  /** The parent-merge relay of a PR stacked on a dependency's PR. */
  relay?: "stacked" | "blocked" | "relayed";
  stack?: "planned" | "blocked";
  // Herdr activity only raises attention for a live worker. It never proves a result.
  activity?: string | null;
  /** The latest report's SuperAgent decision and cleanup, when one was submitted. */
  report?: {
    decision: "accepted" | "returned" | null;
    cleanup: "pending" | "done" | "failed" | "kept" | null;
  };
  cleanup?: "running" | "pending" | "failed" | "done" | "unlanded_work" | "resource_mismatch";
  /** The recorded kind handoff, until its next launch starts. */
  handoff?: "running" | "stopped" | "failed";
  /** A recorded internal review that has not ended. */
  reviewing?: boolean;
  parked?: boolean;
  prClosed?: boolean;
  waking?: "pr_feedback" | "ci_failed" | "pr_relay_blocked";
  /** The plan's assignments with a starting or live worker reach its running cap. ADR-0006. */
  capReached?: boolean;
  /** Kind eligibility for a plain start, not a replacement or kind handoff. */
  dispatchable?: boolean;
  /** Squash delivery does not prove ancestry of retained implementation history. */
  commitHistoryRetained?: boolean;
  commitReview?: {
    rounds: { findings: { severity: string }[] }[];
    dispositions: { round: number; finding: number; disposition: string; reason?: string }[];
  };
  resources?: {
    kind: "pane" | "worktree";
    workerGone: boolean;
    paneGone: boolean;
    worktreeGone: boolean;
    retained?: boolean;
  };
};
type Decision = {
  action:
    | "ready_assignment"
    | "replace_worker"
    | "resume_pr_feedback"
    | "clean_up"
    | "worker_attention"
    | "review_report"
    | "person_decision"
    | "wait"
    | "ended";
  reason:
    | "assignment_ready"
    | "pr_parked"
    | "pr_feedback"
    | "ci_failed"
    | "pr_closed"
    | "worker_idle"
    | "pr_relay_blocked"
    | "stack_pending"
    | "stack_blocked"
    | "dependencies_pending"
    | "running_cap_reached"
    | "assignment_active"
    | "assignment_ended"
    | "cleanup_running"
    | "cleanup_failed"
    | "cleanup_stopped"
    | "cleanup_unlanded_work"
    | "cleanup_resource_mismatch"
    | "launch_starting"
    | "launch_failed"
    | "launch_abandoned"
    | "worker_interrupted"
    | "report_submitted"
    | "follow_up_returned"
    | "kind_handoff"
    | "handoff_failed"
    | "commit_review_limit";
  blockers: {
    assignment: string;
    completion: "pr" | "report" | "commit";
    state: AssignmentState["state"];
    required: "pr-open-or-merged" | "completed" | "merged";
  }[];
};

export function dependencyBlockers(
  assignment: AssignmentState,
  dependencies: AssignmentState[],
): Decision["blockers"] {
  const pending: Decision["blockers"] = dependencies
    .filter((dependency) =>
      dependency.completion === "pr"
        ? dependency.state !== "merged" &&
          (assignment.completion === "commit" || dependency.state !== "pr-open")
        : dependency.state !== "completed",
    )
    .map((dependency) => ({
      assignment: dependency.key,
      completion: dependency.completion,
      state: dependency.state,
      required:
        dependency.completion === "pr"
          ? assignment.completion === "commit"
            ? "merged"
            : "pr-open-or-merged"
          : "completed",
    }));
  return pending;
}

// A PR owner keeps its PR open while it works, so a stopped owner is replaced in either state.
// A report returned with follow-up also needs its worker.
function active({ assignment, report }: Facts) {
  return (
    assignment.state === "running" ||
    assignment.state === "pr-open" ||
    (assignment.state === "reported" && report?.decision === "returned")
  );
}

const rules: { when: (facts: Facts) => boolean; decide: (facts: Facts) => Decision }[] = [
  {
    when: ({ assignment, commitReview }) =>
      assignment.completion === "commit" &&
      assignment.state === "running" &&
      commitReview !== undefined &&
      CommitReview.decide(commitReview.rounds, commitReview.dispositions) === "review_limit",
    decide: () => ({ action: "person_decision", reason: "commit_review_limit", blockers: [] }),
  },
  // Cleanup that an acceptance did not finish stays visible after the assignment ends.
  {
    when: ({ assignment, commitHistoryRetained }) =>
      assignment.completion === "commit" &&
      assignment.state === "completed" &&
      commitHistoryRetained === true,
    decide: () => ({ action: "person_decision", reason: "cleanup_unlanded_work", blockers: [] }),
  },
  {
    when: ({ assignment, report }) =>
      assignment.state === "completed" &&
      report?.decision === "accepted" &&
      (report.cleanup === "failed" || report.cleanup === "pending"),
    decide: ({ report }) => ({
      action: "clean_up",
      // Stryker disable next-line OptionalChaining: equivalent: this rule matches only when a report exists
      reason: report?.cleanup === "failed" ? "cleanup_failed" : "cleanup_stopped",
      blockers: [],
    }),
  },
  {
    when: ({ assignment, report }) =>
      assignment.state === "completed" &&
      report?.decision === "accepted" &&
      report.cleanup === "kept",
    decide: () => ({ action: "person_decision", reason: "cleanup_unlanded_work", blockers: [] }),
  },
  // A merge is complete, but its cleanup stays visible until every resource is disposed.
  {
    when: ({ cleanup }) => cleanup === "running",
    decide: () => ({ action: "wait", reason: "cleanup_running", blockers: [] }),
  },
  // Only the person can authorize deleting unlanded work or decide about a foreign resource.
  {
    when: ({ cleanup }) => cleanup === "unlanded_work",
    decide: () => ({ action: "person_decision", reason: "cleanup_unlanded_work", blockers: [] }),
  },
  {
    when: ({ cleanup }) => cleanup === "resource_mismatch",
    decide: () => ({
      action: "person_decision",
      reason: "cleanup_resource_mismatch",
      blockers: [],
    }),
  },
  {
    when: ({ cleanup }) => cleanup === "failed",
    decide: () => ({ action: "clean_up", reason: "cleanup_failed", blockers: [] }),
  },
  {
    when: ({ cleanup }) => cleanup === "pending",
    decide: () => ({ action: "clean_up", reason: "cleanup_stopped", blockers: [] }),
  },
  {
    when: ({ assignment, resources }) =>
      assignment.state === "abandoned" && resources?.retained === true,
    decide: () => ({ action: "person_decision", reason: "cleanup_unlanded_work", blockers: [] }),
  },
  {
    when: ({ assignment, resources }) =>
      assignment.state !== "ready" &&
      resources !== undefined &&
      (resources.kind === "pane"
        ? resources.paneGone
        : resources.workerGone && resources.worktreeGone),
    decide: () => ({ action: "ended", reason: "assignment_ended", blockers: [] }),
  },
  {
    when: ({ assignment }) => ["merged", "completed", "abandoned"].includes(assignment.state),
    decide: () => ({ action: "ended", reason: "assignment_ended", blockers: [] }),
  },
  // A submitted report waits for the SuperAgent, even when its worker pane has ended.
  {
    when: ({ assignment, report }) => assignment.state === "reported" && report?.decision === null,
    decide: () => ({ action: "review_report", reason: "report_submitted", blockers: [] }),
  },
  // The outgoing session ends at the handoff by design, so it is not an interrupted worker.
  {
    when: ({ assignment, handoff, stack }) =>
      (assignment.state === "pr-open" ||
        (assignment.completion === "commit" && assignment.state === "running")) &&
      stack === undefined &&
      handoff === "running",
    decide: () => ({ action: "wait", reason: "kind_handoff", blockers: [] }),
  },
  {
    when: ({ assignment, handoff, stack }) =>
      (assignment.state === "pr-open" ||
        (assignment.completion === "commit" && assignment.state === "running")) &&
      stack === undefined &&
      handoff === "failed",
    decide: () => ({
      action: "replace_worker",
      reason: "handoff_failed",
      blockers: [],
    }),
  },
  {
    when: ({ assignment, handoff, stack }) =>
      (assignment.state === "pr-open" ||
        (assignment.completion === "commit" && assignment.state === "running")) &&
      stack === undefined &&
      handoff === "stopped",
    decide: () => ({
      action: "replace_worker",
      reason: "handoff_failed",
      blockers: [],
    }),
  },
  {
    when: ({ assignment, prClosed }) => assignment.state === "pr-open" && prClosed === true,
    decide: () => ({ action: "clean_up", reason: "pr_closed", blockers: [] }),
  },
  {
    when: ({ assignment, parked, waking }) =>
      assignment.state === "pr-open" && parked === true && waking !== undefined,
    decide: ({ waking }) => ({
      action: "resume_pr_feedback",
      reason: waking ?? "pr_feedback",
      blockers: [],
    }),
  },
  {
    when: ({ assignment, parked }) => assignment.state === "pr-open" && parked === true,
    decide: () => ({ action: "wait", reason: "pr_parked", blockers: [] }),
  },
  {
    when: (facts) => active(facts) && facts.launch === "failed",
    decide: () => ({ action: "replace_worker", reason: "launch_failed", blockers: [] }),
  },
  {
    when: (facts) => active(facts) && facts.launch === "interrupted",
    decide: () => ({ action: "replace_worker", reason: "worker_interrupted", blockers: [] }),
  },
  {
    when: (facts) => active(facts) && facts.launch === "abandoned",
    decide: () => ({ action: "replace_worker", reason: "launch_abandoned", blockers: [] }),
  },
  {
    when: ({ assignment, pullRequest, launch }) =>
      assignment.state === "pr-open" &&
      pullRequest === "stopped" &&
      launch !== "starting" &&
      launch !== "running",
    decide: () => ({ action: "replace_worker", reason: "worker_interrupted", blockers: [] }),
  },
  {
    when: ({ assignment, report, launch }) =>
      assignment.state === "reported" && report?.decision === "returned" && launch === "running",
    decide: () => ({ action: "worker_attention", reason: "follow_up_returned", blockers: [] }),
  },
  {
    when: ({ launch }) => launch === "starting",
    decide: () => ({ action: "wait", reason: "launch_starting", blockers: [] }),
  },
  // A relay that stopped at a conflict or a failed effect is not a completed relay.
  {
    when: ({ stack }) => stack !== undefined,
    decide: ({ stack }) => ({
      action: stack === "blocked" ? "worker_attention" : "wait",
      reason: stack === "blocked" ? "stack_blocked" : "stack_pending",
      blockers: [],
    }),
  },
  // Between waits the owner works on a result. An idle or done host has left its loop.
  {
    when: ({ assignment, launch, pullRequest, activity }) =>
      assignment.state === "pr-open" &&
      launch === "running" &&
      pullRequest !== "waiting" &&
      (activity === "idle" || activity === "done"),
    decide: () => ({ action: "worker_attention", reason: "worker_idle", blockers: [] }),
  },
  {
    when: ({ assignment }) => assignment.state === "pr-open",
    decide: () => ({ action: "wait", reason: "assignment_active", blockers: [] }),
  },
  // Before a PR or a report exists, an idle or done host has stopped without a result.
  {
    when: ({ assignment, launch, activity }) =>
      assignment.state === "running" &&
      launch === "running" &&
      (activity === "idle" || activity === "done"),
    decide: () => ({ action: "worker_attention", reason: "worker_idle", blockers: [] }),
  },
  {
    when: ({ assignment }) => assignment.state !== "ready",
    decide: () => ({ action: "wait", reason: "assignment_active", blockers: [] }),
  },
  {
    when: ({ dispatchable }) => dispatchable === false,
    decide: () => ({ action: "wait", reason: "kind_handoff", blockers: [] }),
  },
  {
    when: ({ assignment, dependencies }) => dependencyBlockers(assignment, dependencies).length > 0,
    decide: ({ assignment, dependencies }) => ({
      action: "wait",
      reason: "dependencies_pending",
      blockers: dependencyBlockers(assignment, dependencies),
    }),
  },
  // Only ready work is held. A replacement keeps work that already holds its place going.
  {
    when: ({ capReached }) => capReached === true,
    decide: () => ({ action: "wait", reason: "running_cap_reached", blockers: [] }),
  },
];

/** Herdr activity only raises attention for an idle worker. It never proves a result. */
export function decideAssignment(facts: Facts): Decision {
  return (
    rules.find((rule) => rule.when(facts))?.decide(facts) ?? {
      action: "ready_assignment",
      reason: "assignment_ready",
      blockers: [],
    }
  );
}
