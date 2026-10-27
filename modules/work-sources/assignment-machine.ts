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
  launch?: "starting" | "abandoned" | "running" | "failed" | "interrupted";
  pullRequest?: "idle" | "waiting" | "stopped" | "reported" | "timed_out" | "not_open";
  // Herdr activity only raises attention for a PR owner. It never proves a result.
  activity?: string | null;
};
type Decision = {
  action: "ready_assignment" | "replace_worker" | "owner_attention" | "wait" | "ended";
  reason:
    | "assignment_ready"
    | "pr_feedback_loop"
    | "pr_wait_timed_out"
    | "pr_wait_stopped"
    | "pr_owner_idle"
    | "pr_not_open"
    | "dependencies_pending"
    | "assignment_active"
    | "assignment_ended"
    | "launch_starting"
    | "launch_failed"
    | "launch_abandoned"
    | "worker_interrupted";
  blockers: {
    assignment: string;
    completion: "pr" | "report";
    state: AssignmentState["state"];
    required: "pr-open-or-merged" | "completed";
  }[];
};

export function dependencyBlockers(dependencies: AssignmentState[]): Decision["blockers"] {
  return dependencies
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
}

// A PR owner keeps its PR open while it works, so a stopped owner is replaced in either state.
function active({ assignment }: Facts) {
  return assignment.state === "running" || assignment.state === "pr-open";
}

const rules: { when: (facts: Facts) => boolean; decide: (facts: Facts) => Decision }[] = [
  {
    when: ({ assignment }) => ["merged", "completed", "abandoned"].includes(assignment.state),
    decide: () => ({ action: "ended", reason: "assignment_ended", blockers: [] }),
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
    when: ({ launch }) => launch === "starting",
    decide: () => ({ action: "wait", reason: "launch_starting", blockers: [] }),
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
    when: ({ dependencies }) => dependencyBlockers(dependencies).length > 0,
    decide: ({ dependencies }) => ({
      action: "wait",
      reason: "dependencies_pending",
      blockers: dependencyBlockers(dependencies),
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
