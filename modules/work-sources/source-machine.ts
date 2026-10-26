import type { AssignmentState } from "./assignment-machine.ts";

export type SourceState = "open" | "finished" | "reset";
type Facts = { state: SourceState; assignments: AssignmentState[] };
const rules: { when: (facts: Facts) => boolean; state: SourceState }[] = [
  { when: ({ state }) => state === "reset", state: "reset" },
  { when: ({ state }) => state === "finished", state: "finished" },
  {
    when: ({ assignments }) =>
      assignments.every((assignment) =>
        assignment.completion === "pr"
          ? assignment.state === "merged"
          : assignment.state === "completed",
      ),
    state: "finished",
  },
  { when: () => true, state: "open" },
];

export function decideSource(facts: Facts): SourceState {
  for (const rule of rules) if (rule.when(facts)) return rule.state;
  // oxlint-disable-next-line unthrown/no-throw -- The final rule is unconditional, so this is a programming defect.
  throw new Error("The source table has no matching rule.");
}
