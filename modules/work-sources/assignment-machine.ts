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
};
type Decision = {
  action: "ready_assignment" | "replace_worker" | "wait" | "ended";
  reason:
    | "assignment_ready"
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

const rules: { when: (facts: Facts) => boolean; decide: (facts: Facts) => Decision }[] = [
  {
    when: ({ assignment }) => ["merged", "completed", "abandoned"].includes(assignment.state),
    decide: () => ({ action: "ended", reason: "assignment_ended", blockers: [] }),
  },
  {
    when: ({ assignment, launch }) => assignment.state === "running" && launch === "failed",
    decide: () => ({ action: "replace_worker", reason: "launch_failed", blockers: [] }),
  },
  {
    when: ({ assignment, launch }) => assignment.state === "running" && launch === "interrupted",
    decide: () => ({ action: "replace_worker", reason: "worker_interrupted", blockers: [] }),
  },
  {
    when: ({ assignment, launch }) => assignment.state === "running" && launch === "abandoned",
    decide: () => ({ action: "replace_worker", reason: "launch_abandoned", blockers: [] }),
  },
  {
    when: ({ launch }) => launch === "starting",
    decide: () => ({ action: "wait", reason: "launch_starting", blockers: [] }),
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
