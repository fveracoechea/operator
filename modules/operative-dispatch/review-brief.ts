// Bun has no path manipulation API.
import { basename } from "node:path";

// These follow the submission contract in crew-state. A launch cannot import that module,
// because crew-state is what calls this one, so the union shapes are restated rather than widened.
export type ReviewArtifact = {
  name: string;
  kind: "value" | "path";
  value: string;
  contentIdentity: string;
  storedPath: string | null;
};

export type ReviewPullRequest =
  | { status: "open"; number: number; headCommit: string }
  | { status: "authority-missing"; detail: string };

/**
 * One earlier round on the same assignment.
 * A revised result is reviewed against what those rounds found, their dispositions, and the
 * corrections that were delegated, so a regression is visible as one.
 */
export type PriorRound = {
  reviewId: string;
  submissionId: string;
  submissionIdentity: string;
  findings: Array<{
    findingId: string;
    axis: string;
    key: string;
    severity: string;
    summary: string;
    disposition: string | null;
    reason: string | null;
  }>;
  cycles: Array<{
    cycleId: string;
    reason: string;
    cycleIndex: number;
    instruction: string;
    conflicts: Array<{ summary: string; between: string[] }>;
  }>;
};

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
  code: {
    baseCommit: string;
    resultCommit: string;
    mergeBase: string;
    branch: string;
    pullRequest: ReviewPullRequest;
  } | null;
  checks: Array<{
    name: string;
    command: string;
    outcome: "passed" | "failed" | "flaky" | "not-run";
    detail: string;
  }>;
  concerns: string[];
  decisions: Array<{
    statement: string;
    authority: "requirement" | "human-answer" | "operator-decision";
    reason: string;
  }>;
  artifacts: ReviewArtifact[];
  priorRounds: PriorRound[];
};

/** The directory a review worktree receives its fixed copies of the submitted artifacts in. */
export const REVIEW_INPUT_DIR = ".operator/local/review";

export function reviewInputPath(artifact: ReviewArtifact): string | null {
  return artifact.storedPath === null
    ? null
    : `${REVIEW_INPUT_DIR}/${basename(artifact.storedPath)}`;
}

function pullRequestLine(pull: ReviewPullRequest): string {
  return pull.status === "open"
    ? `- Pull request: #${pull.number} at head ${pull.headCommit}`
    : `- Pull request: not created (${pull.detail})`;
}

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
          pullRequestLine(review.code.pullRequest),
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
    ...(review.concerns.length === 0
      ? ["None recorded."]
      : review.concerns.map((one) => `- ${one}`)),
    "",
    "### Decisions the producer made",
    "",
    ...(review.decisions.length === 0
      ? ["None recorded."]
      : review.decisions.map((one) => `- ${one.statement} (${one.authority}): ${one.reason}`)),
    "",
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
    ...review.priorRounds.flatMap((round) => [
      `- Review ${round.reviewId} of submission ${round.submissionId}`,
      ...round.findings.map(
        (one) =>
          `  - ${one.findingId} (${one.axis}, ${one.severity}) ${one.disposition ?? "undisposed"}: ${one.summary}` +
          (one.reason === null ? "" : ` [${one.reason}]`),
      ),
      ...round.cycles.flatMap((cycle) => [
        `  - Rework cycle ${cycle.cycleId} (${cycle.reason} ${cycle.cycleIndex}): ${cycle.instruction}`,
        ...cycle.conflicts.map(
          (one) => `    - Conflict settled by the Operative: ${one.summary} (${one.between.join(" and ")})`,
        ),
      ]),
    ]),
    "",
    "A rejected or deferred finding was answered by the Operator. Do not reopen it as new work,",
    "and do report it if the revised result made it worse.",
    "",
  ];
}

/**
 * The review protocol of one reviewer.
 * Both axes run as native sub-agents of this host, in parallel and in separate contexts, and
 * neither one may change the work it reads.
 */
export function reviewProtocolSection(review: ReviewBrief): string[] {
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
    "Load the `code-review` skill from this worktree and follow it.",
    "",
    `Run the ${review.axes.join(" and ")} axes as native sub-agents of your own host.`,
    "Start them in parallel, in separate contexts, and give each one the fixed inputs above.",
    "Never start a Herdr agent, create a Herdr worktree, or ask the Operator for another crew slot.",
    "",
    "Your sub-agents may read files and run the recorded check commands.",
    "They must never edit a file, commit, push, or perform rework.",
    "Rework is a separate assignment that a fresh Operative receives.",
    "",
    ...research,
    "## Reporting protocol",
    "",
    "Acknowledge this assignment before you read anything:",
    "",
    "```",
    `operator attempt acknowledge --request <a new identity you generate> --attempt ${review.attemptId} --json`,
    "```",
    "",
    "Write your result to a JSON file, then record it:",
    "",
    "```",
    `operator review report --request <a new identity you generate> --review ${review.reviewId} --input <path> --json`,
    "```",
    "",
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
      },
      null,
      2,
    ),
    "```",
    "",
    `Each axis states in \`checked\` what it read. This result kind requires ${review.requiredCoverage.join(", ")}.`,
    ...(review.priorRounds.length === 0
      ? []
      : [
          "Read the earlier rounds above as well. Both axes check the revised result against the",
          "prior dispositions, the corrections that were delegated, and any regression.",
        ]),
    "The two sub-agent windows must overlap, because the two axes run at the same time.",
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
