import { z } from "zod";
import type { AcceptedDraft, Findings } from "./draft.ts";

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
export const markerPrefix = "<!-- operator-review ";
type EventFacts = {
  accepted: AcceptedDraft;
  /** The PR author is the posting account, which GitHub does not let approve or request changes. */
  ownPullRequest: boolean;
  origin: string;
};

/** A thread reply that explains a remaining defect keeps that defect open as a blocker. */
function openThreads(draft: AcceptedDraft["draft"]) {
  return draft.threadReplies.filter((reply) => reply.kind === "explain").length;
}

/** Draft blockers, failing required checks, and one entry for all explained threads. */
export function countBlockers(accepted: AcceptedDraft) {
  return blockerShorts(accepted).length;
}

/** The short text of each open blocker, in the order of the review body. */
export function blockerShorts(accepted: AcceptedDraft) {
  const explained = openThreads(accepted.draft);
  return [
    ...accepted.draft.blockers.map((blocker) => blocker.short),
    ...accepted.failingChecks.map((check) => `${check.name} fails`),
    ...(explained === 0
      ? []
      : [`${explained} review thread${explained === 1 ? " stays" : "s stay"} open`]),
  ];
}

const rules: { when: (facts: EventFacts) => boolean; event: ReviewEvent }[] = [
  // An assignment reviewer posts with the owner's account, so its review is always a comment.
  { when: (facts) => facts.ownPullRequest || facts.origin === "assignment", event: "COMMENT" },
  {
    when: (facts) => facts.accepted.draft.blockers.some((blocker) => blocker.impact !== undefined),
    event: "REQUEST_CHANGES",
  },
  { when: (facts) => countBlockers(facts.accepted) > 0, event: "COMMENT" },
];

/**
 * Request changes only for a defect that breaks the app or a security issue. A breach of style or
 * design gives a comment like any other open blocker, and no blocker gives approval.
 */
export function decideEvent(facts: EventFacts): ReviewEvent {
  return rules.find((rule) => rule.when(facts))?.event ?? "APPROVE";
}

/** Approval with an open blocker is refused even when a later rule change would compute it. */
export function approvalBlocked(facts: EventFacts, event: ReviewEvent) {
  return event === "APPROVE" && countBlockers(facts.accepted) > 0;
}

/** Approval waits for every required check, so a check that still runs cannot fail after it. */
export function approvalWaits(facts: EventFacts, event: ReviewEvent) {
  return (
    event === "APPROVE" &&
    (facts.accepted.pendingChecks.length > 0 || !facts.accepted.checksComplete)
  );
}

const impactWords = { breaking: "breaks the app", security: "security issue" } as const;
/** A blocker or a nice to have. A nice to have has no impact, and a stored one can have no short. */
type Finding = Omit<Findings["blockers"][number], "short"> & { short?: string };

function tag(finding: { impact?: keyof typeof impactWords }) {
  return finding.impact === undefined ? "" : ` · ${impactWords[finding.impact]}`;
}

/** The detail and the source of a finding, which its line comment or its body bullet holds. */
function explanation(finding: Finding) {
  return finding.source === undefined
    ? finding.detail
    : `${finding.detail}\n\n**Source:** ${finding.source}`;
}

/**
 * One bullet for each finding. A finding with a line comment gets one short line, because its
 * line comment holds the detail. A finding with no location keeps its detail in the bullet.
 */
function bullet(finding: Finding & { short: string }) {
  const label = `- **${finding.short}**${tag(finding)}`;
  return finding.path === undefined || finding.line === undefined
    ? `${label}\n${explanation(finding).replaceAll(/^(?=.)/gm, "  ")}`
    : `${label} · \`${finding.path}:${finding.line}\``;
}

/** The status words of a review, shared by the GitHub body and the Slack reply. */
export function status(event: ReviewEvent, blockers: number) {
  if (event === "APPROVE") return "Approved";
  if (event === "REQUEST_CHANGES") return "Changes requested";
  return blockers === 0 ? "No blockers" : "Needs changes";
}

/** Nonzero counts, blockers first, each part after a ` · ` separator. */
export function counts(blockers: number, niceToHaves: number) {
  const parts = [
    blockers === 0 ? null : `${blockers} blocker${blockers === 1 ? "" : "s"}`,
    niceToHaves === 0 ? null : `${niceToHaves} nice to have${niceToHaves === 1 ? "" : "s"}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "" : ` · ${parts.join(", ")}`;
}

function checkLines(accepted: AcceptedDraft, required: number) {
  const { draft, failingChecks, pendingChecks } = accepted;
  const ci =
    required === 0
      ? "- No required CI check reports on this PR."
      : `- Required CI: ${required} checks, ${failingChecks.length} failing, ${pendingChecks.length} pending.`;
  return [
    ci,
    ...draft.noise.map(
      (claim) =>
        `- Noise: \`${claim.check}\` fails only in files that this PR does not change (${claim.files.map((file) => `\`${file}\``).join(", ")}). ${claim.reason}`,
    ),
    ...draft.checks.map(
      (check) =>
        `- Reported ${check.kind}: \`${check.command}\` exited ${check.exitCode}.${check.summary === undefined ? "" : ` ${check.summary}`}`,
    ),
  ];
}

/** The facts of a round that posted against an older commit at the head-move limit. */
export const headLimitSchema = z.object({
  reviewedCommit: z.string(),
  head: z.string(),
  moves: z.number().int(),
});
export type HeadLimit = z.infer<typeof headLimitSchema>;

/**
 * The posted text. The marker lets a later post find this review after a lost answer. At the
 * head-move limit, the text states that it covers an older commit than the PR head.
 */
export function renderReview(input: {
  marker: string;
  event: ReviewEvent;
  accepted: AcceptedDraft;
  requiredChecks: number;
  headLimit?: HeadLimit | null;
}) {
  const { draft, failingChecks } = input.accepted;
  const explained = openThreads(draft);
  const blockers = countBlockers(input.accepted);
  const limit = input.headLimit ?? null;
  const sections = [
    `${input.marker}\n**${status(input.event, blockers)}**${counts(blockers, draft.niceToHaves.length)}${limit === null ? "" : ` · reviewed at ${limit.reviewedCommit.slice(0, 7)}`}`,
    limit === null
      ? ""
      : `The PR head moved ${limit.moves} times during this review, so this review covers ${limit.reviewedCommit}, not the current head ${limit.head}.`,
    draft.summary,
    blockers === 0
      ? "No blockers."
      : [
          "**Blockers**",
          ...draft.blockers.map(bullet),
          ...failingChecks.map(
            (check) =>
              `- **CI check ${check.name} fails**${check.url === null ? "" : ` · ${check.url}`}`,
          ),
          ...(explained === 0
            ? []
            : [
                `- **${explained} review thread${explained === 1 ? " stays" : "s stay"} open** · the thread replies explain the remaining defects`,
              ]),
        ].join("\n"),
    draft.niceToHaves.length === 0
      ? ""
      : ["**Nice to have**", ...draft.niceToHaves.map(bullet)].join("\n"),
    ["**Checks**", ...checkLines(input.accepted, input.requiredChecks)].join("\n"),
  ];
  return {
    body: sections.filter((section) => section !== "").join("\n\n"),
    comments: inlineComments(draft),
  };
}

function lineComment(finding: Finding, heading: string) {
  return finding.path === undefined || finding.line === undefined
    ? []
    : [
        {
          path: finding.path,
          line: finding.line,
          body: `**${heading}**${tag(finding)}\n\n${explanation(finding)}`,
        },
      ];
}

/**
 * Inline comments for findings with a location. They depend on the findings alone, so a stored
 * draft from an earlier release gives them too.
 */
export function inlineComments(findings: Findings) {
  return [
    ...findings.blockers.flatMap((blocker) => lineComment(blocker, `Blocker: ${blocker.short}`)),
    // A nice to have that an earlier release stored has no short.
    ...findings.niceToHaves.flatMap((item) =>
      lineComment(item, item.short === undefined ? "Nice to have" : `Nice to have: ${item.short}`),
    ),
  ];
}
