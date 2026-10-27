import type { AcceptedDraft } from "./draft.ts";

export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
type EventFacts = {
  accepted: AcceptedDraft;
  /** The PR author is the posting account, which GitHub does not let approve or request changes. */
  ownPullRequest: boolean;
  origin: string;
};

function blockerCount({ accepted }: EventFacts) {
  return accepted.draft.blockers.length + accepted.failingChecks.length;
}

const rules: { when: (facts: EventFacts) => boolean; event: ReviewEvent }[] = [
  // An assignment reviewer posts with the owner's account, so its review is always a comment.
  { when: (facts) => facts.ownPullRequest || facts.origin === "assignment", event: "COMMENT" },
  {
    when: (facts) => facts.accepted.draft.blockers.some((blocker) => blocker.breach !== undefined),
    event: "REQUEST_CHANGES",
  },
  { when: (facts) => blockerCount(facts) > 0, event: "COMMENT" },
  { when: () => true, event: "APPROVE" },
];

/**
 * Request changes only for a named strong breach of the person's opinions, a project skill, or
 * the architecture. Otherwise an open blocker gives a comment, and no blocker gives approval.
 */
export function decideEvent(facts: EventFacts): ReviewEvent {
  return rules.find((rule) => rule.when(facts))?.event ?? "COMMENT";
}

/** Approval with an open blocker is refused even when a later rule change would compute it. */
export function approvalBlocked(facts: EventFacts, event: ReviewEvent) {
  return event === "APPROVE" && blockerCount(facts) > 0;
}

/** Approval waits for every required check, so a check that still runs cannot fail after it. */
export function approvalWaits(facts: EventFacts, event: ReviewEvent) {
  return (
    event === "APPROVE" &&
    (facts.accepted.pendingChecks.length > 0 || !facts.accepted.checksComplete)
  );
}

function at(finding: { path?: string; line?: number }) {
  return finding.path === undefined ? "" : ` \`${finding.path}:${finding.line}\``;
}

function status(event: ReviewEvent, blockers: number) {
  if (event === "APPROVE") return "Approved";
  if (event === "REQUEST_CHANGES") return "Changes requested";
  return blockers === 0 ? "No blockers" : "Needs changes";
}

function counts(blockers: number, niceToHaves: number) {
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

/** The posted text. The marker lets a later post find this review after a lost answer. */
export function renderReview(input: {
  marker: string;
  event: ReviewEvent;
  accepted: AcceptedDraft;
  requiredChecks: number;
}) {
  const { draft, failingChecks } = input.accepted;
  const blockers = draft.blockers.length + failingChecks.length;
  const breaches = draft.blockers.flatMap((blocker) =>
    blocker.breach === undefined
      ? []
      : [
          `Strong breach of the ${blocker.breach.source}: ${blocker.breach.rule.replace(/[.!?]$/, "")}.`,
        ],
  );
  const sections = [
    `${input.marker}\n**${status(input.event, blockers)}**${counts(blockers, draft.niceToHaves.length)}`,
    draft.summary,
    breaches.join("\n"),
    blockers === 0
      ? "No blockers."
      : [
          "**Blockers**",
          ...draft.blockers.map(
            (blocker, index) =>
              `${index + 1}. **${blocker.short}.** ${blocker.detail}${at(blocker)}`,
          ),
          ...failingChecks.map(
            (check, index) =>
              `${draft.blockers.length + index + 1}. **CI check ${check.name} fails.**${check.url === null ? "" : ` ${check.url}`}`,
          ),
        ].join("\n"),
    draft.niceToHaves.length === 0
      ? ""
      : [
          "**Nice to have**",
          ...draft.niceToHaves.map((item, index) => `${index + 1}. ${item.detail}${at(item)}`),
        ].join("\n"),
    ["**Checks**", ...checkLines(input.accepted, input.requiredChecks)].join("\n"),
  ];
  return {
    body: sections.filter((section) => section !== "").join("\n\n"),
    comments: inlineComments(draft),
  };
}

/** Inline comments for findings with a location. They depend on the draft alone. */
export function inlineComments(draft: AcceptedDraft["draft"]) {
  return [
    ...draft.blockers.flatMap((blocker) =>
      blocker.path === undefined || blocker.line === undefined
        ? []
        : [
            {
              path: blocker.path,
              line: blocker.line,
              body: `Blocker. ${blocker.short}. ${blocker.detail}`,
            },
          ],
    ),
    ...draft.niceToHaves.flatMap((item) =>
      item.path === undefined || item.line === undefined
        ? []
        : [{ path: item.path, line: item.line, body: `Nice to have. ${item.detail}` }],
    ),
  ];
}
