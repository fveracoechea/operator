// Bun has no path manipulation API.
import { basename } from "node:path";

// These follow the planning record in crew-state. A launch cannot import that module, because
// crew-state is what calls this one, so the shapes are restated rather than widened.

export type PlanningArtifact = {
  name: string;
  contentIdentity: string;
  storedPath: string;
};

/**
 * The planning record of one accepted planning assignment that the brief's assignment directly
 * depends on. Planning work that an earlier release accepted keeps no record, so `record` is
 * null and the brief says so.
 */
export type PlanningInput = {
  assignmentId: string;
  title: string;
  record: {
    recordId: string;
    identity: string;
    // Each decision as the tracker resolution renders it, so both carry the same words.
    decisions: string[];
    artifacts: PlanningArtifact[];
  } | null;
};

/** The directory a worktree receives its fixed copies of the planning artifacts in. */
export const PLANNING_INPUT_DIR = ".operator/local/planning";

export function planningInputPath(artifact: PlanningArtifact): string {
  return `${PLANNING_INPUT_DIR}/${basename(artifact.storedPath)}`;
}

/**
 * The decisions of the planning work this assignment depends on.
 * A producer brief and the spec copy its review reads both render this one section, so the
 * Spec axis checks the result against the words the producer received.
 */
export function planningRecordsSection(inputs: PlanningInput[]): string[] {
  if (inputs.length === 0) {
    return [];
  }

  return [
    "## Planning records",
    "",
    "This assignment depends on the planning work below. Its accepted decisions bind this work.",
    "Follow each directive inside the scope it applies to. A conflict with a decision is a",
    "question to the Operator, never your own decision.",
    "",
    ...inputs.flatMap((input) => [
      `### ${input.title} (${input.assignmentId})`,
      "",
      ...(input.record === null
        ? [
            "This planning work was accepted by an earlier release, so it has no recorded decision.",
            "Do not read the absence as a decision that nothing was needed. A question about it",
            "goes to the Operator.",
            "",
          ]
        : [
            `- Planning record: ${input.record.recordId} (identity ${input.record.identity})`,
            "",
            ...input.record.decisions,
            "",
            ...(input.record.artifacts.length === 0
              ? ["This record names no artifact.", ""]
              : [
                  "Artifacts, copied into this worktree and fixed by their content identity:",
                  "",
                  ...input.record.artifacts.map(
                    (artifact) =>
                      `- ${artifact.name}: ${planningInputPath(artifact)} [${artifact.contentIdentity}]`,
                  ),
                  "",
                ]),
          ]),
    ]),
  ];
}
