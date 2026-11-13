import { z } from "zod";
import { storedFindingsSchema } from "./draft.ts";
import type { Round } from "./request.ts";
import { counts, headLimitSchema, status, type ReviewEvent } from "./review-body.ts";

/** A reply or a reaction that the CLI generates and an agent only transports. */
type SlackEffect = { key: string; kind: "reply" | "reaction"; content: string };

/** The approved reactions. They only add, so earlier reactions stay on the message. */
const reactions = {
  start: "eyes",
  APPROVE: "white_check_mark",
  REQUEST_CHANGES: "request-changes",
  COMMENT: "speech_balloon",
} as const;
const bulletLimit = 3;

function reaction(name: string): SlackEffect {
  return { key: `reaction:${name}`, kind: "reaction", content: name };
}

/** The start reaction, when Slack gives Operator a PR to review. */
export function startEffects(): SlackEffect[] {
  return [reaction(reactions.start)];
}

/** The open blockers of a posted round. A round from before this record uses its draft. */
function blockersOf(round: Round) {
  if (round.blockers !== null) return z.array(z.string()).parse(JSON.parse(round.blockers));
  return storedFindingsSchema
    .parse(JSON.parse(round.draft))
    .blockers.map((blocker) => blocker.short);
}

function eventOf(round: Round): ReviewEvent {
  return round.event === "APPROVE" || round.event === "REQUEST_CHANGES" ? round.event : "COMMENT";
}

/**
 * One reply line for the round, then at most three blocker bullets. A later round says how many
 * blockers of the previous round are gone. The reviewed-at suffix appears only at the head-move
 * limit. There is no title, greeting, or mention.
 */
export function replyText(rounds: Round[], round: Round, fallbackUrl: string) {
  const blockers = blockersOf(round);
  const niceToHaves = storedFindingsSchema.parse(JSON.parse(round.draft)).niceToHaves.length;
  const previous = rounds.findLast((row) => row.outcome === "posted" && row.number < round.number);
  const before = previous === undefined ? 0 : blockersOf(previous).length;
  const progress =
    before === 0 ? "" : ` · ${Math.max(0, before - blockers.length)} of ${before} fixed`;
  const limit = round.warning === null ? null : headLimitSchema.parse(JSON.parse(round.warning));
  const suffix = limit === null ? "" : ` · reviewed at ${limit.reviewedCommit.slice(0, 7)}`;
  const line = `${status(eventOf(round), blockers.length)}${counts(blockers.length, niceToHaves)}${progress} · [review](${round.reviewUrl ?? fallbackUrl})${suffix}`;
  return [
    line,
    ...blockers
      .slice(0, bulletLimit)
      .map((blocker) => `• ${blocker.replaceAll(/\s+/g, " ").trim()}`),
  ].join("\n");
}

/** The outcome reaction and the one threaded reply of a posted round. */
export function roundEffects(rounds: Round[], round: Round, fallbackUrl: string): SlackEffect[] {
  return [
    reaction(reactions[eventOf(round)]),
    { key: `reply:${round.number}`, kind: "reply", content: replyText(rounds, round, fallbackUrl) },
  ];
}
