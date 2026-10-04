import { type CommandRule, REFERENCE_RULES, ruleLines } from "./command-rules.ts";
import {
  artifactCopies,
  copiedInputPath,
  type FixedArtifact,
  type FixedCheck,
  type FixedCode,
  type RoleCopies,
  storedCopy,
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

export type ReviewBrief = {
  reviewId: string;
  attemptId: string;
  submissionId: string;
  submissionIdentity: string;
  resultKind: "code" | "non-code";
  axes: string[];
  requiredCoverage: string[];
  producerAssignmentId: string;
  producerTitle: string;
  assignmentRevision: number;
  sourceRevision: string;
  requirementsIdentity: string;
  reviewBase: string | null;
  code: FixedCode | null;
  checks: FixedCheck[];
  concerns: string[];
  decisions: SubmittedDecision[];
  behaviorChanges: SubmittedBehaviorChanges;
  artifacts: FixedArtifact[];
  // The fixed copy of the producer's scope, requirements, and inputs, taken at submission.
  // A review registered before that copy existed carries none.
  spec: { storedPath: string; contentIdentity: string } | null;
  // The commit `code-review` diffs from, and the read-only `git` commands it runs from there.
  fixedPoint: string | null;
  readCommands: string[];
  // The patch that was reviewed and the interdiff from it to this one, fixed at submission when
  // this result is the combined revision of an integration cycle (ADR 0017). Null otherwise.
  integration: {
    reviewedPatch: { storedPath: string; contentIdentity: string };
    interdiff: { storedPath: string; contentIdentity: string };
  } | null;
  // Each question that a behavior change names as its basis, with its answer.
  basisQuestions: AnsweredQuestion[];
  priorRounds: PriorRound[];
  // True for the only code result of its source: no branch review follows, so this review
  // writes the text of the pull request that publishes it.
  publishes: boolean;
};

/** The directory a review worktree receives its fixed copies of the submitted artifacts in. */
export const REVIEW_INPUT_DIR = ".operator/local/review";

/** Where the reviewer reads the fixed spec copy, which `code-review` takes as its spec path. */
export const REVIEW_SPEC_PATH = `${REVIEW_INPUT_DIR}/spec.md`;

/** Where the reviewer reads the patch that was reviewed and the interdiff from it to this one. */
export const REVIEWED_PATCH_PATH = `${REVIEW_INPUT_DIR}/reviewed-patch.diff`;
export const INTERDIFF_PATH = `${REVIEW_INPUT_DIR}/interdiff.diff`;

export function reviewInputPath(artifact: FixedArtifact): string | null {
  return copiedInputPath(REVIEW_INPUT_DIR, artifact);
}

/**
 * The fixed copies a reviewer reads, never the worktree that produced them: the submitted
 * artifacts, then the spec copy, the reviewed patch, and the interdiff.
 */
export function copiesOf(review: ReviewBrief, projectRoot: string): RoleCopies {
  return {
    artifacts: artifactCopies(REVIEW_INPUT_DIR, review.artifacts, projectRoot),
    texts: [
      ...(review.spec === null ? [] : [storedCopy(REVIEW_SPEC_PATH, review.spec, projectRoot)]),
      ...(review.integration === null
        ? []
        : [
            storedCopy(REVIEWED_PATCH_PATH, review.integration.reviewedPatch, projectRoot),
            storedCopy(INTERDIFF_PATH, review.integration.interdiff, projectRoot),
          ]),
    ],
  };
}

/** What a behavior change is, in the words of `CONTEXT.md`. */
export const BEHAVIOR_CHANGE_LINES = [
  "A behavior change is a difference, compared with the base, in what changed code does for some",
  "input: an output, an error, a record that is dropped or skipped, or a boundary value that falls",
  "in another class. A change to a comment, a private name, or a test is not one.",
];

/** The example of the published text in a report shape. */
export const PUBLISHED_TEXT_SHAPE = {
  title: "<the pull request title, at most 256 characters>",
  summary: "<what this change does and why, for a person who reviews it on GitHub>",
  startHere: "<the file or commit to read first, and why>",
  mergeDanger: "<what can break when this merges, or that nothing known can>",
};

/**
 * What the published text is. The reviewer read the whole subject, so it writes the judgment
 * that no record holds, and the Operator only passes it on (ADR 0022).
 */
export const PUBLISHED_TEXT_LINES = [
  "Write `published` once, beside `reports`: the text of the pull request that publishes what you",
  "read. The person reads it on GitHub and approves it word for word, and the Operator changes",
  "nothing in it. The CLI renders every other section from the records, so do not repeat the",
  "commit list, the checks, or the findings.",
  "- `title`: one line that names the change.",
  "- `summary`: what the change does and why.",
  "- `startHere`: where a reader starts, and why there.",
  "- `mergeDanger`: what can break when it merges, or that you know of nothing.",
];

/** The fixed result the two axes read. Every line here is pinned at submission. */
export function submittedResultSection(review: ReviewBrief): string[] {
  return [
    "## The submitted result",
    "",
    `- Review: ${review.reviewId}`,
    `- Submission: ${review.submissionId} (identity ${review.submissionIdentity})`,
    `- Result kind: ${review.resultKind}`,
    `- Producer assignment: ${review.producerAssignmentId} (${review.producerTitle})`,
    `- Assignment revision: ${review.assignmentRevision}`,
    `- Requirement revision: ${review.sourceRevision} (requirements ${review.requirementsIdentity})`,
    ...(review.code === null
      ? ["- Code revisions: none recorded"]
      : [
          `- Base commit: ${review.code.baseCommit}`,
          `- Submitted commit: ${review.code.resultCommit}`,
          `- Merge base: ${review.code.mergeBase}`,
          `- Branch: ${review.code.branch}`,
        ]),
    "",
    "### Artifacts",
    "",
    ...(review.artifacts.length === 0
      ? ["This submission fixed no artifacts."]
      : review.artifacts.map((artifact) => {
          const local = reviewInputPath(artifact);
          return `- ${artifact.name} (${artifact.kind}): ${local ?? artifact.value} [${artifact.contentIdentity}]`;
        })),
    "",
    "A copied artifact is the fixed evidence. Read the copy, never the producer worktree.",
    "",
    "### Checks the producer ran",
    "",
    ...(review.checks.length === 0
      ? ["This submission recorded no checks."]
      : review.checks.map((check) => `- ${check.name}: ${check.outcome} (\`${check.command}\`)`)),
    "",
    "### Known concerns",
    "",
    ...concernLines(review.concerns),
    "",
    "### Decisions the producer made",
    "",
    ...decisionLines(review.decisions),
    "",
    "### Behavior changes",
    "",
    ...behaviorChangeLines(review.behaviorChanges),
    "",
    ...(review.basisQuestions.length === 0
      ? []
      : [
          "### Questions that a behavior change names as its basis",
          "",
          ...answeredQuestionLines(review.basisQuestions),
          "",
        ]),
    ...priorRoundsSection(review),
  ];
}

/** What earlier rounds found on this assignment, and what was delegated about it. */
function priorRoundsSection(review: ReviewBrief): string[] {
  if (review.priorRounds.length === 0) {
    return [];
  }

  return [
    "### Earlier rounds on this assignment",
    "",
    "This result is a revision. Check it against every line below, and report a finding that",
    "returned as a regression.",
    "",
    ...roundLines(review.priorRounds),
    "",
    "A rejected or deferred finding was answered by the Operator. Do not reopen it as new work,",
    "and do report it if the revised result made it worse.",
    "",
  ];
}

/**
 * The three inputs `code-review` takes: a spec path, a fixed point, and the commands that read
 * the diff from it. The spec is a copy fixed at submission, because the issue can change after
 * registration and the reviewer has no network.
 */
function readingLines(review: ReviewBrief): string[] {
  return [
    review.spec === null
      ? "- Spec: no copy was recorded for this submission. Read the approved scope and acceptance requirements above."
      : `- Spec: ${REVIEW_SPEC_PATH} (requirements ${review.requirementsIdentity}). Read this copy, never the live issue.`,
    review.fixedPoint === null
      ? "- Fixed point: none, because this result is not code."
      : `- Fixed point: ${review.fixedPoint}`,
    ...(review.readCommands.length === 0
      ? []
      : ["- Read commands:", ...review.readCommands.map((one) => `  - ${one}`)]),
    // A conflict resolution can change what unchanged lines mean, so the reviewer reads the whole
    // result, and the interdiff only shows where it differs from the patch that was reviewed.
    ...(review.integration === null
      ? []
      : [
          `- Reviewed patch: ${REVIEWED_PATCH_PATH}. This result applies it again on the commit it lands on.`,
          `- Interdiff: ${INTERDIFF_PATH}, from the reviewed patch to the patch of this result. Review the whole result, not only the interdiff.`,
        ]),
  ];
}

/**
 * The review protocol of one reviewer.
 * Both axes run as native sub-agents of this host, in parallel and in separate contexts, and
 * neither one may change the work it reads.
 */
export function reviewProtocolSection(
  review: ReviewBrief,
  rules: CommandRule[],
  invocation = "operator",
): string[] {
  const research =
    review.resultKind === "code"
      ? []
      : [
          "This result is not code.",
          "Check that every conclusion is supported by a citation you can follow, and that the",
          "unresolved limits are stated. Check the provenance of each recorded answer: a requirement,",
          "a human answer, and an Operator decision are three different authorities.",
          "Do not create a commit merely to obtain a diff.",
          "",
        ];

  return [
    "## Review protocol",
    "",
    "Load the `code-review` skill from this worktree and follow it with these inputs:",
    "",
    ...readingLines(review),
    "",
    `Run the ${review.axes.join(" and ")} axes as native sub-agents of your own host.`,
    "Start them in parallel, in separate contexts, and give each one the fixed inputs above.",
    "Never start a Herdr agent, create a Herdr worktree, or ask the Operator for another crew slot.",
    "",
    "Your sub-agents may read files, run the read commands above, and run the recorded check commands.",
    "Never push, and never perform rework.",
    "Rework is a separate assignment that a fresh Operative receives.",
    "",
    ...research,
    "## Reporting protocol",
    "",
    "Acknowledge this assignment before you review the submitted result:",
    "",
    "```",
    `${invocation} attempt acknowledge --request <a new identity you generate> --attempt ${review.attemptId} --json`,
    "```",
    "",
    ...ruleLines(REFERENCE_RULES),
    "Write your result to a JSON file, then record it:",
    "",
    "```",
    `${invocation} review report --request <a new identity you generate> --review ${review.reviewId} --input <path> --json`,
    "```",
    "",
    ...ruleLines(rules),
    "A complete report carries this shape:",
    "",
    "```json",
    JSON.stringify(
      {
        kind: "reported",
        submissionIdentity: review.submissionIdentity,
        host: "<your host>",
        subAgents: review.axes.map((axis) => ({
          axis,
          name: `<sub-agent name for ${axis}>`,
          host: "<your host>",
          startedAt: "<ISO timestamp>",
          endedAt: "<ISO timestamp>",
          status: "completed",
        })),
        reports: review.axes.map((axis) => ({
          axis,
          summary: `<what the ${axis} axis found>`,
          checked: review.requiredCoverage,
          observedChecks: [{ name: "<a recorded check you ran>", outcome: "passed" }],
          findings: [
            {
              key: "<a short stable key>",
              severity: "blocker",
              summary: "<what is wrong>",
              evidence: "<file, line, or quoted requirement>",
            },
          ],
        })),
        // JSON leaves an undefined field out, so only a review that publishes shows the text.
        published: review.publishes ? PUBLISHED_TEXT_SHAPE : undefined,
      },
      null,
      2,
    ),
    "```",
    "",
    ...(review.publishes
      ? [
          "This is the only code result of its source, so no branch review follows it.",
          ...PUBLISHED_TEXT_LINES,
          "",
        ]
      : []),
    `This result kind requires ${review.requiredCoverage.join(", ")} in \`checked\`.`,
    ...(review.behaviorChanges === null
      ? []
      : [
          "",
          ...BEHAVIOR_CHANGE_LINES,
          "Both axes read the behavior changes above against the diff and the spec, and state",
          "`behavior-changes` in `checked`. A behavior change that the list leaves out, or an entry",
          "whose basis does not permit it, is a blocker finding. An empty list states that there is",
          "none, so check that statement too.",
        ]),
    ...(review.priorRounds.length === 0
      ? []
      : [
          "Read the earlier rounds above as well. Both axes check the revised result against the",
          "prior dispositions, the corrections that were delegated, and any regression.",
        ]),
    "",
    "Record in `observedChecks` every recorded check you ran for yourself, with what you saw.",
    "That reading outranks the producer's own word, so an outcome that differs blocks acceptance.",
    "Leave the list empty when an axis ran no check.",
    "",
    "If this host cannot run the required sub-agents, or a credential or input is missing, record",
    "the blocker instead of a partial review:",
    "",
    "```json",
    JSON.stringify(
      {
        kind: "blocked",
        submissionIdentity: review.submissionIdentity,
        host: "<your host>",
        blocker: { reason: "review_capability_unavailable", detail: "<what is unavailable>" },
      },
      null,
      2,
    ),
    "```",
    "",
    "Never substitute a single-context self-review. A partial report cannot accept anything.",
    "",
  ];
}
