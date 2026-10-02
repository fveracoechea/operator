import {
  copiedInputPath,
  type FixedArtifact,
  type FixedCheck,
  type FixedCode,
} from "./fixed-result.ts";
import {
  type AnsweredQuestion,
  answeredQuestionLines,
  behaviorChangeLines,
  concernLines,
  decisionLines,
  type PriorRound,
  roundLines,
  type SubmittedBehaviorChanges,
  type SubmittedDecision,
} from "./recorded-rounds.ts";

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

/** What an invalidation cycle corrects, fixed when the defect was recorded. */
export type ReworkInvalidation = {
  invalidationId: string;
  defect: { summary: string; evidence: string; foundBy: string };
  // The commit the correction takes the place of, and the commit it starts at, which is the same
  // landed commit. A non-code result lands nothing, so both are null.
  landedCommit: string | null;
  startCommit: string | null;
};

/** Why an integration cycle combines, read from the landing plan when it was delegated. */
export type ReworkIntegration = {
  branch: string;
  tip: string;
  commit: string;
  cause: "conflict" | "patch-changed" | "gate-failed" | "gate-flaky";
  paths: string[];
  gateRunId: string | null;
  // The landed commit a correction replaces, when the cycle answers a rewrite (ADR 0020).
  replaces?: string | undefined;
};

export type ReworkBrief = {
  cycleId: string;
  reason: "findings" | "integration" | "diagnostic" | "invalidation";
  cycleIndex: number;
  limit: number;
  approvalId: string | null;
  reviewId: string | null;
  submissionId: string;
  submissionIdentity: string;
  resultKind: "code" | "non-code";
  corrections: ReworkCorrection[];
  conflicts: Array<{ summary: string; between: string[] }>;
  combines: Array<{ name: string; revision: string }>;
  checks: FixedCheck[];
  code: FixedCode | null;
  artifacts: FixedArtifact[];
  // Present only on an invalidation cycle. A cycle that an earlier release recorded has none.
  invalidation?: ReworkInvalidation | undefined;
  // Present only on an integration cycle that read a landing plan.
  integration?: ReworkIntegration | undefined;
  // The recorded rounds of the assignment, derived at dispatch. They do not change once recorded,
  // and the brief identity covers them, so every attempt of this cycle receives the same text.
  rounds: ReworkRounds;
};

/** What the crew state recorded about the earlier rounds of the assignment (ADR 0008). */
export type ReworkRounds = {
  // What the producer of the corrected submission recorded beside its result.
  concerns: string[];
  decisions: SubmittedDecision[];
  behaviorChanges: SubmittedBehaviorChanges;
  answeredQuestions: AnsweredQuestion[];
  earlier: PriorRound[];
};

// The Operator writes no instruction of its own into a cycle (ADR 0008), so each reason renders
// one fixed sentence that the release owns, and the recorded content below is the work.
const REASON_SENTENCE: Record<ReworkBrief["reason"], string> = {
  findings: "Answer every accepted correction below in one revision.",
  integration:
    "Apply the submitted result again on the commit it lands on, and combine every revision below in one revision.",
  diagnostic: "Run the checks below again and record what you observe.",
  invalidation:
    "Correct the defect below in one revision that takes the place of the accepted result.",
};

/** The directory a rework worktree receives its fixed copies of the submitted artifacts in. */
export const REWORK_INPUT_DIR = ".operator/local/rework";

export function reworkInputPath(artifact: FixedArtifact): string | null {
  return copiedInputPath(REWORK_INPUT_DIR, artifact);
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
    ...(rework.approvalId === null
      ? []
      : [`- This cycle runs past the recorded limit under approval ${rework.approvalId}.`]),
    `- Result kind: ${rework.resultKind}`,
    ...(rework.code === null
      ? ["- Code revisions: none recorded"]
      : [`- Submitted commit: ${rework.code.resultCommit}`, `- Branch: ${rework.code.branch}`]),
    "",
    REASON_SENTENCE[rework.reason],
    "",
    ...(rework.invalidation === undefined ? [] : defectSection(rework.invalidation)),
    ...(rework.integration === undefined ? [] : integrationSection(rework.integration)),
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
    ...recordedRoundsSection(rework.rounds),
  ];
}

/**
 * The defect an invalidation found in the accepted result, in the words of whoever found it.
 * The Operator adds nothing to it, so the fresh Operative reads what the finder recorded.
 */
function defectSection(invalidation: ReworkInvalidation): string[] {
  return [
    "### The defect found in the accepted result",
    "",
    `- Invalidation: ${invalidation.invalidationId}`,
    `- Summary: ${invalidation.defect.summary}`,
    `- Evidence: ${invalidation.defect.evidence}`,
    `- Found by: ${invalidation.defect.foundBy}`,
    `- Landed commit: ${invalidation.landedCommit ?? "none, because a non-code result lands nothing"}`,
    "",
  ];
}

const CAUSE_LINE: Record<ReworkIntegration["cause"], string> = {
  conflict: "The submitted commit conflicts with the tip.",
  "patch-changed": "The submitted commit lands on the tip as another patch than the one reviewed.",
  "gate-failed": "The planned commit on the tip failed the project gate.",
  "gate-flaky": "The planned commit on the tip is flaky at the project gate.",
};

/**
 * Why the submitted result no longer lands as it was reviewed, as the landing plan read it. The
 * failed gate run is a fixed artifact below, so the Operative reads its output, never a claim.
 */
function integrationSection(integration: ReworkIntegration): string[] {
  return [
    "### Why the result no longer lands",
    "",
    `- ${CAUSE_LINE[integration.cause]}`,
    `- Integration branch: ${integration.branch}`,
    `- Recorded tip when the cycle was delegated: ${integration.tip}`,
    `- Submitted commit: ${integration.commit}`,
    ...(integration.paths.length === 0
      ? []
      : [`- Conflicting paths: ${integration.paths.join(", ")}`]),
    ...(integration.gateRunId === null
      ? []
      : [`- Failed gate run: ${integration.gateRunId}. Its output is in the fixed copies below.`]),
    "",
  ];
}

/**
 * What the earlier rounds of this assignment recorded.
 * A fresh Operative writes every correction and holds none of the producer's context, so the
 * answers, decisions, and findings that shaped the result reach it from the crew state.
 */
function recordedRoundsSection(rounds: ReworkRounds): string[] {
  return [
    "### Known concerns of the corrected submission",
    "",
    ...concernLines(rounds.concerns),
    "",
    "### Decisions of the corrected submission",
    "",
    ...decisionLines(rounds.decisions),
    "",
    "### Behavior changes of the corrected submission",
    "",
    ...behaviorChangeLines(rounds.behaviorChanges),
    "",
    "### Answered questions",
    "",
    ...answeredQuestionLines(rounds.answeredQuestions),
    "",
    "### Earlier rounds on this assignment",
    "",
    ...(rounds.earlier.length === 0 ? ["None recorded."] : roundLines(rounds.earlier)),
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

  const start = rework.invalidation?.startCommit ?? null;
  return [
    "## Rework protocol",
    "",
    // A correction of a landed commit starts at that commit, and acceptance puts the combined
    // change in its place on the branch (ADR 0020). An integration cycle starts from the commit
    // its result lands on: the recorded tip, or the parent of the replaced commit (ADR 0008).
    ...(rework.integration !== undefined
      ? [
          rework.integration.replaces === undefined
            ? `Your worktree starts from the recorded tip of ${rework.integration.branch}, the commit your result lands on.`
            : `Your worktree starts from the parent of ${rework.integration.replaces} on ${rework.integration.branch}, the commit your correction lands on in its place.`,
          "Make one new commit on that commit that applies the submitted commit above to it, so do",
          "not build on the submitted commit. The new commit is a new submission with its own review.",
        ]
      : start === null
        ? ["Start from the submitted commit above, not from the original base."]
        : [
            `Your worktree starts at ${start}, the landed commit.`,
            "Make one commit on top of it that corrects the defect. At acceptance the CLI puts one",
            "commit with the landed change and your correction in the place of the landed commit,",
            "and it lands each later commit of the branch again above it.",
          ]),
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
