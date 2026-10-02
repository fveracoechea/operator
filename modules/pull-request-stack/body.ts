/**
 * GitHub refuses a pull request body over this many characters with HTTP 422. The REST
 * documentation states no limit, so the number is GitHub's own validation message, recorded on
 * ticket #118. A JavaScript length counts UTF-16 units, which is never fewer than characters.
 */
export const BODY_LIMIT = 65_536;

/** What permits one behavior change (ADR 0018), with the requirement text when it names one. */
export type BehaviorBasis =
  | { kind: "approved-scope" }
  | { kind: "requirement"; position: number; text: string | null }
  | { kind: "question"; questionId: string };

/** One commit of a pull request, in landing order, with the records its body renders. */
export type PublishCommit = {
  commit: string;
  subject: string;
  /** The issue its item closes, as `<owner>/<repo>#<n>`, or null for an item with no ticket. */
  closes: string | null;
  behaviorChanges: Array<{ statement: string; basis: BehaviorBasis }>;
  concerns: string[];
};

/** The text a reviewer wrote for the pull request. The Operator passes it on unchanged. */
export type PublishedText = {
  title: string;
  summary: string;
  startHere: string;
  mergeDanger: string;
};

/** The recorded evidence the Verified section names. */
export type Verified = {
  gateCommands: string[];
  gateRuns: Array<{ runId: string; commit: string; at: "base" | "commit" }>;
  reviews: Array<{ kind: "result" | "branch"; reviewId: string; subject: string; host: string }>;
};

export type RejectedFinding = {
  summary: string;
  reason: string;
  evidence: string;
  targets: string[];
};

export type DeferredFinding = { summary: string; reason: string; followUp: string };

export type BodyInput = {
  repository: string;
  text: PublishedText;
  commits: PublishCommit[];
  verified: Verified;
  rejected: RejectedFinding[];
  deferred: DeferredFinding[];
};

function short(commit: string): string {
  return commit.slice(0, 12);
}

function basisText(basis: BehaviorBasis): string {
  if (basis.kind === "approved-scope") {
    return "the approved scope";
  }
  if (basis.kind === "question") {
    return `the answer to question ${basis.questionId}`;
  }
  return basis.text === null
    ? `acceptance requirement ${basis.position}`
    : `acceptance requirement ${basis.position}, "${basis.text}"`;
}

function section(title: string, lines: string[]): string[] {
  return [`## ${title}`, "", ...lines, ""];
}

function listOrNone(lines: string[]): string[] {
  return lines.length === 0 ? ["None."] : lines;
}

/**
 * Renders the body of one pull request from the records and the reviewer text, in the fixed
 * order of decision 16 of the publish. Every section that is not reviewer text is rendered, so
 * no recorded fact is written twice. A stack of one part has no stack section.
 */
export function renderBody(input: BodyInput): string {
  const commitLink = (commit: string) => `https://github.com/${input.repository}/commit/${commit}`;
  const lines = [
    ...section("Summary", [input.text.summary]),
    ...section("Commits", [
      "Review this pull request one commit at a time.",
      "",
      ...input.commits.map(
        (one) =>
          `- [${one.subject}](${commitLink(one.commit)})${one.closes === null ? "" : ` Closes ${one.closes}.`}`,
      ),
    ]),
    ...section("Start here", [input.text.startHere]),
    ...section(
      "Behavior changes",
      listOrNone(
        input.commits.flatMap((one) =>
          one.behaviorChanges.length === 0
            ? []
            : [
                `- ${short(one.commit)} ${one.subject}:`,
                ...one.behaviorChanges.map(
                  (change) => `  - ${change.statement} (basis: ${basisText(change.basis)})`,
                ),
              ],
        ),
      ),
    ),
    ...section("Verified", [
      `- Project gate: ${input.verified.gateCommands.map((one) => `\`${one}\``).join(", ")}.`,
      ...input.verified.gateRuns.map(
        (one) =>
          `- Gate run ${one.runId} passed at ${one.at === "base" ? "the base " : ""}${short(one.commit)}.`,
      ),
      ...input.verified.reviews.map(
        (one) =>
          `- ${one.kind === "branch" ? "Branch review" : "Result review"} ${one.reviewId} of ${one.subject} by ${one.host}.`,
      ),
    ]),
    ...section(
      "Looks wrong and is not",
      listOrNone(
        input.rejected.map(
          (one) =>
            `- ${one.summary} (${one.targets.map(short).join(", ")}) Rejected: ${one.reason} Evidence: ${one.evidence}`,
        ),
      ),
    ),
    ...section(
      "Not in this pull request",
      listOrNone(
        input.deferred.map(
          (one) => `- ${one.summary} Deferred: ${one.reason} Follow-up: ${one.followUp}`,
        ),
      ),
    ),
    ...section(
      "Concerns",
      listOrNone(
        input.commits.flatMap((one) =>
          one.concerns.map((concern) => `- ${short(one.commit)}: ${concern}`),
        ),
      ),
    ),
    ...section("Merge danger", [input.text.mergeDanger]),
    ...section("How to merge", ["Merge with a merge commit."]),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The slot of a resolution that the plan cannot fill: the number GitHub gives the pull request. */
export const PULL_REQUEST_SLOT = "<the number of its pull request>";

/** How the commit of one item reached the target, when it was not by a merge commit. */
export type Landed = { commit: string; method: string };

/**
 * Renders the resolution of one code item after its pull request merged (decision 18). It has no
 * free text: the commit on the target, the pull request, and the behavior changes with their
 * basis. After another merge method it names the commit that landed and the method. The plan
 * renders it with the pull request slot, and the publish approval binds that text (D2).
 */
export function renderResolution(input: {
  repository: string;
  target: string;
  commit: string;
  behaviorChanges: PublishCommit["behaviorChanges"];
  pullRequest: number | null;
  landed: Landed | null;
}): string {
  const link = (commit: string) =>
    `[\`${short(commit)}\`](https://github.com/${input.repository}/commit/${commit})`;
  const pull = `${input.repository}#${input.pullRequest ?? PULL_REQUEST_SLOT}`;
  const done =
    input.landed === null
      ? `Done in ${link(input.commit)} in ${pull}, merged into \`${input.target}\` by a merge commit.`
      : `Done in ${link(input.landed.commit)} in ${pull}, merged into \`${input.target}\` by a ${input.landed.method} merge, not a merge commit. The reviewed commit was ${link(input.commit)}.`;
  const lines = [
    done,
    "",
    "Behavior changes:",
    "",
    ...listOrNone(
      input.behaviorChanges.map(
        (change) => `- ${change.statement} (basis: ${basisText(change.basis)})`,
      ),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
