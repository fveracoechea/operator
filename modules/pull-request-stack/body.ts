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
  reviews: Array<{
    kind: "result" | "branch";
    reviewId: string;
    subject: string;
    host: string;
    /** The commit a result review read, or null for the branch review of the whole head. */
    commit: string | null;
  }>;
};

export type RejectedFinding = {
  summary: string;
  reason: string;
  evidence: string;
  targets: string[];
};

export type DeferredFinding = { summary: string; reason: string; followUp: string };

/** Where one pull request sits in a stack of more than one part. */
export type StackPlace = {
  part: number;
  of: number;
  /** The other parts by position, with how many commits each holds. */
  others: Array<{ part: number; commits: number }>;
};

/**
 * The one slot of a body: the number GitHub gives the pull request below, which is recorded by
 * the time this one is created (decision 16).
 */
export const BELOW_SLOT = "<the number of the part below>";

export type BodyInput = {
  repository: string;
  text: PublishedText;
  commits: PublishCommit[];
  verified: Verified;
  rejected: RejectedFinding[];
  deferred: DeferredFinding[];
  /** Null for a stack of one, which has no stack section. */
  stack: StackPlace | null;
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
 * no recorded fact is written twice. A stack of one part has no stack section. Each body covers
 * only its own commits, and names only the pull request below it.
 */
export function renderBody(input: BodyInput): string {
  const commitLink = (commit: string) => `https://github.com/${input.repository}/commit/${commit}`;
  const { stack } = input;
  const lines = [
    ...section("Summary", [input.text.summary]),
    ...(stack === null
      ? []
      : section("Stack", [
          `Part ${stack.part} of ${stack.of}.`,
          ...(stack.part === 1 ? [] : ["", `Based on #${BELOW_SLOT}. Merge #${BELOW_SLOT} first.`]),
        ])),
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
      listOrNone([
        ...input.deferred.map(
          (one) => `- ${one.summary} Deferred: ${one.reason} Follow-up: ${one.followUp}`,
        ),
        ...(stack?.others ?? []).map(
          (one) => `- Part ${one.part} of ${stack?.of ?? 1}, with ${one.commits} commit(s).`,
        ),
      ]),
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
    ...section("How to merge", [
      "Merge with a merge commit.",
      ...(stack === null ? [] : ["", "Merge from the bottom up."]),
    ]),
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

/**
 * Why one published range is recalled, read from a record with no free text (D1): an open
 * defect of an accepted result, as `work invalidate` recorded it, or a withdrawal, as the
 * registration plan that the person approved recorded it.
 */
export type RecallCause =
  | {
      kind: "defect";
      item: string;
      summary: string;
      evidence: string;
      foundBy: string;
    }
  | { kind: "withdrawal"; item: string; planRevision: string };

/** The hidden line by which a repeat finds the one comment that an effect wrote. */
export function commentMarker(id: string): string {
  return `<!-- operator:stack-comment:v1 ${id} -->`;
}

function causeLine(cause: RecallCause): string {
  return cause.kind === "defect"
    ? `- A defect in ${cause.item}: ${cause.summary} Evidence: ${cause.evidence} Found by ${cause.foundBy}.`
    : `- ${cause.item} is withdrawn: a person removed its issue from the parent, and registration plan ${cause.planRevision} recorded the withdrawal.`;
}

/**
 * The one comment a recall adds to each pull request it turns into a draft (decision 23). The
 * reason is rendered from the records. With no replacement, the comment names the close that
 * the same approval covers, because every code item of the source is withdrawn (decision 30).
 */
export function renderRecall(input: {
  marker: string;
  causes: RecallCause[];
  replaced: boolean;
}): string {
  const lines = [
    "Operator recalled this pull request to a draft. Do not merge it.",
    "",
    ...section("Why", input.causes.map(causeLine)),
    ...section("What follows", [
      input.replaced
        ? "Its commits change on the integration branch first. Then a new stack publication replaces this pull request and closes it with a link to its replacement."
        : "Every code item of this source is withdrawn, so no new stack publication replaces this pull request. Operator closes it now. No branch is deleted.",
    ]),
    input.marker,
  ];
  return `${lines.join("\n")}\n`;
}
