// Bun has no path manipulation API.
import { basename } from "node:path";
import type { ReviewArtifact, ReviewPullRequest } from "./review-brief.ts";

// These follow the rework contract in crew-state. A launch cannot import that module, because
// crew-state is what calls this one, so the shapes are restated rather than widened.
export type ReworkCorrection = {
  findingId: string;
  axis: string;
  key: string;
  severity: string;
  summary: string;
  evidence: string;
  reason: string;
};

export type ReworkBrief = {
  cycleId: string;
  reason: "findings" | "integration" | "diagnostic";
  cycleIndex: number;
  limit: number;
  instruction: string;
  reviewId: string | null;
  submissionId: string;
  submissionIdentity: string;
  resultKind: "code" | "non-code";
  corrections: ReworkCorrection[];
  conflicts: Array<{ summary: string; between: string[] }>;
  combines: Array<{ name: string; revision: string }>;
  checks: Array<{ name: string; command: string; outcome: string; detail: string }>;
  code: {
    baseCommit: string;
    resultCommit: string;
    mergeBase: string;
    branch: string;
    pullRequest: ReviewPullRequest;
  } | null;
  artifacts: ReviewArtifact[];
};

/** The directory a rework worktree receives its fixed copies of the submitted artifacts in. */
export const REWORK_INPUT_DIR = ".operator/local/rework";

export function reworkInputPath(artifact: ReviewArtifact): string | null {
  return artifact.storedPath === null
    ? null
    : `${REWORK_INPUT_DIR}/${basename(artifact.storedPath)}`;
}

function pullRequestLine(pull: ReviewPullRequest): string {
  return pull.status === "open"
    ? `- Pull request: #${pull.number} at head ${pull.headCommit}`
    : `- Pull request: not created (${pull.detail})`;
}

/**
 * The result this cycle reworks and the findings it must answer.
 * Every line is fixed when the cycle is delegated, so a later change to the review or to the
 * producer worktree cannot change the work this Operative was given.
 */
export function reworkResultSection(rework: ReworkBrief): string[] {
  return [
    "## The result you rework",
    "",
    `- Rework cycle: ${rework.cycleId} (${rework.reason} cycle ${rework.cycleIndex} of ${rework.limit})`,
    `- Submission: ${rework.submissionId} (identity ${rework.submissionIdentity})`,
    `- Review: ${rework.reviewId ?? "none"}`,
    `- Result kind: ${rework.resultKind}`,
    ...(rework.code === null
      ? ["- Code revisions: none recorded"]
      : [
          `- Submitted commit: ${rework.code.resultCommit}`,
          `- Branch: ${rework.code.branch}`,
          pullRequestLine(rework.code.pullRequest),
        ]),
    "",
    `The Operator asks for this: ${rework.instruction}`,
    "",
    "### Accepted corrections",
    "",
    ...(rework.corrections.length === 0
      ? ["This cycle carries no finding."]
      : rework.corrections.flatMap((one) => [
          `- ${one.findingId} (${one.axis}, ${one.severity}): ${one.summary}`,
          `  Reviewer evidence: ${one.evidence}`,
          `  The Operator accepted it because: ${one.reason}`,
        ])),
    "",
    "A finding the Operator rejected or deferred is answered already. Do not act on it.",
    "",
    "### Conflicts to settle",
    "",
    ...(rework.conflicts.length === 0
      ? ["None recorded."]
      : rework.conflicts.flatMap((one) => [
          `- ${one.summary}`,
          `  Between: ${one.between.join(" and ")}`,
        ])),
    "",
    "### Revisions to combine",
    "",
    ...(rework.combines.length === 0
      ? ["None recorded."]
      : rework.combines.map((one) => `- ${one.name}: ${one.revision}`)),
    "",
    "### Checks",
    "",
    ...(rework.checks.length === 0
      ? ["This submission recorded no checks."]
      : rework.checks.map((one) => `- ${one.name}: ${one.outcome} (\`${one.command}\`)`)),
    "",
    "### Fixed copies of the submitted artifacts",
    "",
    ...(rework.artifacts.length === 0
      ? ["This submission fixed no artifacts."]
      : rework.artifacts.map((artifact) => {
          const local = reworkInputPath(artifact);
          return `- ${artifact.name}: ${local ?? artifact.value} [${artifact.contentIdentity}]`;
        })),
    "",
  ];
}

/**
 * How one rework cycle ends.
 * Everything above is answered in one combined revision, because a review reads one fixed
 * result and a half-corrected result would be reviewed as if it were the whole answer.
 */
export function reworkProtocolSection(rework: ReworkBrief): string[] {
  const diagnostic =
    rework.reason === "diagnostic"
      ? [
          "This is a diagnostic rerun. Run the named checks again and record what you observe.",
          "Change the product code only if the rerun proves the failure is in it.",
          "",
        ]
      : [];

  return [
    "## Rework protocol",
    "",
    "Start from the submitted commit above, not from the original base.",
    "Answer every accepted correction, every conflict, and every revision to combine in one",
    "combined revision, then submit that one revision.",
    "Two submissions would split the evidence, and a review reads one fixed result.",
    "",
    "Settle every conflict above yourself. The Operator delegated it and recorded no answer of",
    "its own, so choosing between the two is your work and your submitted decision.",
    "",
    "The acceptance requirements above still stand. A correction never widens the approved scope.",
    "",
    ...diagnostic,
  ];
}
