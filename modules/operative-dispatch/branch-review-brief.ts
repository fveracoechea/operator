import { type CommandRule, REFERENCE_RULE, ruleLines } from "./command-rules.ts";
import { PUBLISHED_TEXT_LINES, PUBLISHED_TEXT_SHAPE, REVIEW_INPUT_DIR } from "./review-brief.ts";

/**
 * What a cut point is (ADR 0015). The branch reviewer read the whole head, so it proposes each
 * cut with its reason, and the person approves the cuts in the publish approval (D1).
 */
const CUT_LINES = [
  "`cuts` divides the head into a pull request stack, from the bottom up. Leave it `[]` for one",
  "pull request, which is the default. Each cut ends the part below it after the commit `after`,",
  "names in `reason` why the review divides there, and carries the text of the part above it.",
  "A cut falls only between two neighbouring commits: `after` is a commit of the snapshot that is",
  "not the head, and the cuts follow the landing order. Cut only where a reviewer of a smaller",
  "part reads a complete topic.",
];

/** One commit of the branch snapshot, in branch order, with the accepted result it carries. */
export type BranchCommit = {
  assignmentId: string;
  sourceKey: string;
  title: string;
  submissionId: string;
  commit: string;
};

/** One earlier review of the source, with every finding and the answer it received. */
export type EarlierReview = {
  reviewId: string;
  // "branch" for an earlier branch round, "result" for the result review of one commit.
  kind: "branch" | "result";
  subject: string;
  findings: Array<{
    findingId: string;
    axis: string;
    key: string;
    severity: string;
    summary: string;
    disposition: string | null;
    reason: string | null;
    targets: string[] | null;
  }>;
};

/**
 * The brief of one branch review. It reads the integration branch of a source as a whole, from
 * its base to one head, so it finds what no result review could see (ADR 0017).
 */
export type BranchReviewBrief = {
  reviewId: string;
  attemptId: string;
  sourceId: string;
  snapshotId: string;
  snapshotIdentity: string;
  baseCommit: string;
  headCommit: string;
  commits: BranchCommit[];
  axes: string[];
  requiredCoverage: string[];
  // The fixed text of the source, stored at registration, and the fixed spec copy of every
  // item, each taken when its result was submitted.
  specs: Array<{ name: string; storedPath: string; contentIdentity: string }>;
  // The fixed point is the base of the integration branch, so the diff is the whole range.
  fixedPoint: string;
  readCommands: string[];
  gateCommands: string[];
  earlierReviews: EarlierReview[];
};

/** Where the reviewer reads one spec copy: the text of the source or the spec of one item. */
export function branchSpecPath(index: number): string {
  return `${REVIEW_INPUT_DIR}/spec-${index + 1}.md`;
}

/** The fixed snapshot both axes read. Every line here is pinned at registration. */
export function branchSnapshotSection(review: BranchReviewBrief): string[] {
  return [
    "## The branch snapshot",
    "",
    `- Review: ${review.reviewId}`,
    `- Source: ${review.sourceId}`,
    `- Snapshot: ${review.snapshotId} (identity ${review.snapshotIdentity})`,
    `- Base commit: ${review.baseCommit}`,
    `- Head commit: ${review.headCommit}`,
    "",
    "### Commits, in branch order",
    "",
    ...review.commits.map(
      (one, index) =>
        `${index + 1}. ${one.commit} ${one.sourceKey} (${one.title}): assignment ${one.assignmentId}, accepted submission ${one.submissionId}`,
    ),
    "",
    "### Specs",
    "",
    ...(review.specs.length === 0
      ? ["No item recorded a spec copy. Read the approved scope and acceptance requirements above."]
      : review.specs.map(
          (one, index) =>
            `- ${one.name}: ${branchSpecPath(index)} [${one.contentIdentity}]. Read this copy, never the live issue.`,
        )),
    "",
    ...earlierSection(review.earlierReviews),
  ];
}

/** What every earlier review of the source found, and what the Operator answered. */
function earlierSection(earlier: EarlierReview[]): string[] {
  if (earlier.length === 0) {
    return [];
  }
  return [
    "### Earlier reviews of this source",
    "",
    "Read these as context. Report a finding that returned as a regression.",
    "A rejected or deferred finding was answered by the Operator. Do not reopen it as new work.",
    "",
    ...earlier.flatMap((one) => [
      `- ${one.kind === "branch" ? "Branch review" : "Result review"} ${one.reviewId} of ${one.subject}:`,
      ...(one.findings.length === 0
        ? ["  - no finding"]
        : one.findings.map(
            (finding) =>
              `  - ${finding.findingId} ${finding.axis} ${finding.severity} ${finding.disposition ?? "undisposed"}${finding.targets === null ? "" : ` targets ${finding.targets.join(", ")}`}: ${finding.summary}${finding.reason === null ? "" : ` (${finding.reason})`}`,
          )),
    ]),
    "",
  ];
}

/**
 * The review protocol of one branch reviewer. Both axes run as native sub-agents of this host,
 * in parallel and in separate contexts, read the whole range, and name the commits of each
 * finding.
 */
export function branchReviewProtocolSection(
  review: BranchReviewBrief,
  rules: CommandRule[],
  invocation = "operator",
): string[] {
  return [
    "## Review protocol",
    "",
    "Load the `code-review` skill from this worktree and follow it with these inputs:",
    "",
    `- Spec: the spec copies above, which together are the spec of source ${review.sourceId}.`,
    `- Fixed point: ${review.fixedPoint}, the base of the integration branch.`,
    "- Commit list: the commits above, in branch order.",
    "- Read commands:",
    ...review.readCommands.map((one) => `  - ${one}`),
    "",
    "Every commit above already passed its own result review. Look for what no result review",
    "could see: a relation between two or more commits, and the coverage of the source as a whole.",
    "Still report a defect inside one commit that its result review missed.",
    "Name in `targets` the full SHA of each commit a finding needs. A finding that joins two",
    "commits names both.",
    "",
    `Run the ${review.axes.join(" and ")} axes as native sub-agents of your own host.`,
    "Start them in parallel, in separate contexts, and give each one the fixed inputs above.",
    "Never start a Herdr agent, create a Herdr worktree, or ask the Operator for another crew slot.",
    "",
    "Your sub-agents may read files, run the read commands above, and run the project gate commands:",
    ...review.gateCommands.map((one) => `- ${one}`),
    "Run each project gate command at the head, and record what you saw in `observedChecks` with",
    "the command line above as `name`. Publish compares each one with the gate run at the head, so",
    "a command with no observation, or with another outcome, stops the publish.",
    "Never push, and never perform rework.",
    "",
    "## Reporting protocol",
    "",
    "Acknowledge this assignment before you review the branch:",
    "",
    "```",
    `${invocation} attempt acknowledge --request <a new identity you generate> --attempt ${review.attemptId} --json`,
    "```",
    "",
    ...ruleLines([REFERENCE_RULE]),
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
        snapshotIdentity: review.snapshotIdentity,
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
          observedChecks: [{ name: "<a project gate command you ran>", outcome: "passed" }],
          findings: [
            {
              key: "<a short stable key>",
              severity: "blocker",
              summary: "<what is wrong>",
              evidence: "<file, line, or quoted requirement>",
              targets: ["<the full SHA of each commit this finding needs>"],
            },
          ],
        })),
        published: {
          ...PUBLISHED_TEXT_SHAPE,
          cuts: [
            {
              after: "<the full SHA of the last commit of the part below>",
              reason: "<why the review divides here>",
              ...PUBLISHED_TEXT_SHAPE,
            },
          ],
        },
      },
      null,
      2,
    ),
    "```",
    "",
    `A branch review requires ${review.requiredCoverage.join(", ")} in \`checked\`.`,
    "",
    ...PUBLISHED_TEXT_LINES,
    "",
    ...CUT_LINES,
    "",
    "If this host cannot run the required sub-agents, or a credential or input is missing, record",
    "the blocker instead of a partial review:",
    "",
    "```json",
    JSON.stringify(
      {
        kind: "blocked",
        snapshotIdentity: review.snapshotIdentity,
        host: "<your host>",
        blocker: { reason: "review_capability_unavailable", detail: "<what is unavailable>" },
      },
      null,
      2,
    ),
    "```",
    "",
    "Never substitute a single-context self-review. A partial report cannot publish anything.",
    "",
  ];
}
