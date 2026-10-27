import { z } from "zod";

export const assignmentStateSchema = z.discriminatedUnion("completion", [
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
  // Herdr activity only raises attention for a PR owner. It never proves a result.
  activity?: string | null;
  /** The latest report's SuperAgent decision and cleanup, when one was submitted. */
  report?: {
    decision: "accepted" | "returned" | null;
    cleanup: "pending" | "done" | "failed" | null;
  };
  cleanup?: "running" | "pending" | "failed" | "done" | "unlanded_work" | "resource_mismatch";
};
type Decision = {
  action:
    | "ready_assignment"
    | "replace_worker"
    | "owner_attention"
    | "review_report"
    | "resume_worker"
    | "retry_cleanup"
    | "person_decision"
    | "wait"
    | "ended";
  reason:
    | "assignment_ready"
    | "pr_feedback_loop"
    | "pr_wait_timed_out"
    | "pr_wait_stopped"
    | "pr_owner_idle"
    | "pr_not_open"
    | "pr_relay_blocked"
    | "dependencies_pending"
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
    | "cleanup_unfinished";
  blockers: {
    assignment: string;
    completion: "pr" | "report";
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
        ? dependency.state !== "pr-open" && dependency.state !== "merged"
        : dependency.state !== "completed",
    )
    .map((dependency) => ({
      assignment: dependency.key,
      completion: dependency.completion,
      state: dependency.state,
      required: dependency.completion === "pr" ? "pr-open-or-merged" : "completed",
    }));
  // A PR stacks on one parent branch. With several open parents, all but one must merge first.
  const open = dependencies.filter((dependency) => dependency.state === "pr-open");
  const stacks =
    assignment.completion === "pr" && open.length > 1
      ? open.map((dependency) => ({
          assignment: dependency.key,
          completion: dependency.completion,
          state: dependency.state,
          required: "merged" as const,
        }))
      : [];
  return [...pending, ...stacks];
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
  // Cleanup that an acceptance did not finish stays visible after the assignment ends.
  {
    when: ({ assignment, report }) =>
      assignment.state === "completed" &&
      report?.decision === "accepted" &&
      (report.cleanup === "failed" || report.cleanup === "pending"),
    decide: ({ report }) => ({
      action: "retry_cleanup",
      reason: report?.cleanup === "failed" ? "cleanup_failed" : "cleanup_unfinished",
      blockers: [],
    }),
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
    decide: () => ({ action: "retry_cleanup", reason: "cleanup_failed", blockers: [] }),
  },
  {
    when: ({ cleanup }) => cleanup === "pending",
    decide: () => ({ action: "retry_cleanup", reason: "cleanup_stopped", blockers: [] }),
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
    when: ({ assignment, report, launch }) =>
      assignment.state === "reported" && report?.decision === "returned" && launch === "running",
    decide: () => ({ action: "resume_worker", reason: "follow_up_returned", blockers: [] }),
  },
  {
    when: ({ launch }) => launch === "starting",
    decide: () => ({ action: "wait", reason: "launch_starting", blockers: [] }),
  },
  // A relay that stopped at a conflict or a failed effect is not a completed relay.
  {
    when: ({ assignment, relay }) => assignment.state === "pr-open" && relay === "blocked",
    decide: () => ({ action: "owner_attention", reason: "pr_relay_blocked", blockers: [] }),
  },
  // A timeout or a PR that is no longer open never proves completion. The SuperAgent decides.
  {
    when: ({ assignment, pullRequest }) =>
      assignment.state === "pr-open" && pullRequest === "timed_out",
    decide: () => ({ action: "owner_attention", reason: "pr_wait_timed_out", blockers: [] }),
  },
  {
    when: ({ assignment, pullRequest }) =>
      assignment.state === "pr-open" && pullRequest === "not_open",
    decide: () => ({ action: "owner_attention", reason: "pr_not_open", blockers: [] }),
  },
  {
    when: ({ assignment, pullRequest }) =>
      assignment.state === "pr-open" && pullRequest === "stopped",
    decide: () => ({ action: "owner_attention", reason: "pr_wait_stopped", blockers: [] }),
  },
  // Between waits the owner works on a result. An idle or done host has left its loop.
  {
    when: ({ assignment, pullRequest, activity }) =>
      assignment.state === "pr-open" &&
      pullRequest !== "waiting" &&
      (activity === "idle" || activity === "done"),
    decide: () => ({ action: "owner_attention", reason: "pr_owner_idle", blockers: [] }),
  },
  {
    when: ({ assignment }) => assignment.state === "pr-open",
    decide: () => ({ action: "wait", reason: "pr_feedback_loop", blockers: [] }),
  },
  {
    when: ({ assignment }) => assignment.state !== "ready",
    decide: () => ({ action: "wait", reason: "assignment_active", blockers: [] }),
  },
  {
    when: ({ assignment, dependencies }) => dependencyBlockers(assignment, dependencies).length > 0,
    decide: ({ assignment, dependencies }) => ({
      action: "wait",
      reason: "dependencies_pending",
      blockers: dependencyBlockers(assignment, dependencies),
    }),
  },
  {
    when: () => true,
    decide: () => ({ action: "ready_assignment", reason: "assignment_ready", blockers: [] }),
  },
];

/** This dispatch decision uses only recorded facts. Herdr activity is never an input. */
export function decideAssignment(facts: Facts): Decision {
  for (const rule of rules) if (rule.when(facts)) return rule.decide(facts);
  // oxlint-disable-next-line unthrown/no-throw -- The final rule is unconditional, so this is a programming defect.
  throw new Error("The assignment table has no matching rule.");
}
