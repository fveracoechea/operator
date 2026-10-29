import { ErrAsync, OkAsync, type AsyncResult, type OkOf } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { readPullRequest, type Target } from "./github.ts";
import type { Failure, Outcome, Paths } from "./request.ts";
import { startEffects } from "./slack-effects.ts";
import { advanceWatch, parseAcknowledgement, parseChannelRead, slackTs } from "./slack-input.ts";

/** A channel read is due five minutes after the last ingest. */
export const readIntervalMs = 5 * 60 * 1000;
const inputHint = "<file>";

type Policy = { channel: string; repos: string[]; authors: string[] };
type Read = OkOf<ReturnType<typeof DeviceState.readSlack>>;
export type SlackView = ReturnType<typeof view>;

function policy(paths: Paths): AsyncResult<Policy | null, Failure> {
  return DeviceSettings.slackReviewPolicy(paths);
}

/** The exact MCP call that carries one effect. The agent passes these parameters unchanged. */
function call(effect: Read["effects"][number]) {
  return effect.kind === "reply"
    ? {
        tool: "slack_send_message",
        params: { channel_id: effect.channel, thread_ts: effect.threadTs, message: effect.content },
      }
    : {
        tool: "slack_add_reaction",
        params: { channel_id: effect.channel, message_ts: effect.threadTs, emoji: effect.content },
      };
}

function view(policy: Policy, read: Read, now: number) {
  const watch = read.watch;
  const readAt = watch?.readAt ?? null;
  const dueAt = readAt === null ? now : Date.parse(readAt) + readIntervalMs;
  const params: { channel_id: string; oldest?: string; latest?: string } = {
    channel_id: policy.channel,
  };
  // Before the first Slack loop there is no cursor, and the tool takes no null.
  if (watch !== null) {
    params.oldest = watch.cursor;
    // Set while Slack pages older messages: the next read asks only for messages before it.
    if (watch.latest !== null) params.latest = watch.latest;
  }
  return {
    channel: policy.channel,
    // Before the first watch, the read is due and the Slack loop records its start cursor.
    read:
      dueAt > now
        ? null
        : {
            tool: "slack_read_channel",
            params,
            command: `operator review ingest --input ${inputHint}`,
          },
    nextReadAt: new Date(dueAt).toISOString(),
    effects: read.effects.map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      url: effect.url,
      ...call(effect),
      failure: effect.failure,
      command: `operator review slack-done ${effect.id} --input ${inputHint}`,
    })),
  };
}

/**
 * The Slack transport actions: a due channel read with its cursor, and every pending effect with
 * its exact text or reaction. Null when no channel is set. Only the Slack loop, with `start`,
 * records the start cursor of the channel. Any other read writes nothing.
 */
export function slackActions(paths: Paths, start: boolean): AsyncResult<SlackView | null, Failure> {
  const now = Date.now();
  return policy(paths).flatMap((chosen) => {
    if (chosen === null) return OkAsync(null);
    const started = start
      ? DeviceState.startSlackWatch(paths, chosen.channel, slackTs(now))
      : DeviceState.readSlack(paths, chosen.channel).map(() => undefined);
    return started
      .flatMap(() => DeviceState.readSlack(paths, chosen.channel))
      .toAsync()
      .map((read) => view(chosen, read, now));
  });
}

type Candidate = { target: Target; threadTs: string };
type Ignored = { url: string; reason: string };

/** The PRs of new messages, each once, with the thread of the first message that names it. */
function candidates(messages: { ts: string; threadTs: string; links: Target[] }[]) {
  const found = new Map<string, Candidate>();
  for (const message of messages)
    for (const target of message.links)
      if (!found.has(target.url)) found.set(target.url, { target, threadTs: message.threadTs });
  return [...found.values()];
}

type Screened = { eligible: Candidate[]; ignored: Ignored[] };

/** Why the author policy excludes one PR, or null. Only GitHub logins count. */
function exclusion(
  paths: Paths,
  chosen: Policy,
  target: Target,
): AsyncResult<string | null, Failure> {
  if (!chosen.repos.includes(target.repository)) return OkAsync("repository_not_in_policy");
  return DeviceState.readReviewRequest(paths, target)
    .toAsync()
    .flatMap((recorded): AsyncResult<string | null, Failure> => {
      if (recorded.project === null) return OkAsync("repository_unregistered");
      const authors = chosen.authors.map((author) => author.toLowerCase());
      return readPullRequest(target).map((pr) => {
        // Stryker disable next-line StringLiteral: no rule: the policy lists GitHub logins, so Operator promises nothing for a policy entry that matches the fallback text
        if (!authors.includes((pr.author ?? "").toLowerCase())) return "author_not_in_policy";
        return pr.state === "OPEN" ? null : "pr_not_open";
      });
    });
}

/** Screens each PR in order. A failed GitHub read stops the ingest, so nothing is recorded. */
function screen(paths: Paths, chosen: Policy, found: Candidate[]) {
  return found.reduce<AsyncResult<Screened, Failure>>(
    (previous, candidate) =>
      previous.flatMap((screened) =>
        exclusion(paths, chosen, candidate.target).map((reason) =>
          reason === null
            ? { ...screened, eligible: [...screened.eligible, candidate] }
            : {
                ...screened,
                ignored: [...screened.ignored, { url: candidate.target.url, reason }],
              },
        ),
      ),
    OkAsync({ eligible: [], ignored: [] }),
  );
}

function configured(paths: Paths): AsyncResult<Policy, Failure> {
  return policy(paths).flatMap((chosen) =>
    chosen === null
      ? ErrAsync<Failure>({
          reason: "slack_not_configured",
          detail:
            "No Slack channel is set. Set review.channel, review.repos, and review.authors with operator config apply. Nothing was recorded.",
        })
      : OkAsync(chosen),
  );
}

/**
 * Ingests the raw result of one channel read. It finds the PR links of messages after the cursor,
 * applies the author policy, records each eligible PR with its start reaction, and moves the
 * cursor, all in one write. While Slack pages older messages, the cursor waits for the last page.
 */
export function ingest(input: { paths: Paths; text: string }): AsyncResult<Outcome, Failure> {
  const { paths } = input;
  return configured(paths).flatMap((chosen) =>
    parseChannelRead(input.text)
      .toAsync()
      .flatMap((read) => {
        const start = slackTs(Date.now());
        return DeviceState.startSlackWatch(paths, chosen.channel, start)
          .flatMap(() => DeviceState.readSlack(paths, chosen.channel))
          .toAsync()
          .flatMap((state): AsyncResult<Outcome, Failure> => {
            // Stryker disable next-line ObjectLiteral: equivalent: the start above recorded the watch, so this fallback is never read
            const watch = state.watch ?? { cursor: start, latest: null, pending: null };
            const from = { cursor: watch.cursor, latest: watch.latest, pending: watch.pending };
            // A minute of clock skew. A later ts can only come from a forged line in a body.
            const { fresh, to } = advanceWatch(from, read, slackTs(Date.now() + 60_000));
            return screen(paths, chosen, candidates(fresh)).flatMap((screened) =>
              DeviceState.ingestSlack(paths, {
                channel: chosen.channel,
                from,
                to,
                candidates: screened.eligible.map((candidate) => ({
                  ...candidate.target,
                  threadTs: candidate.threadTs,
                })),
                start: startEffects(),
              })
                .toAsync()
                .flatMap((outcomes) =>
                  DeviceState.readSlack(paths, chosen.channel)
                    .toAsync()
                    .map((after) => view(chosen, after, Date.now()))
                    .map((slack) => ({
                      reason: to.paging ? "slack_ingested_page" : "slack_ingested",
                      data: {
                        channel: chosen.channel,
                        cursor: { from: from.cursor, to: to.cursor },
                        // While paging, the next read is due at once for messages before `latest`.
                        paging: to.paging ? { latest: to.latest } : null,
                        messages: fresh.length,
                        requests: outcomes.map((row) => ({
                          url: row.candidate.url,
                          outcome: row.outcome,
                          id: row.id,
                        })),
                        ignored: screened.ignored,
                        slack,
                      },
                    })),
                ),
            );
          });
      }),
  );
}

/**
 * Records the agent's report of one sent effect from the raw send result. Only a result that
 * shows success marks it done. A Slack error or an unknown result keeps the effect pending, so the
 * next wait gives it again. An acknowledgement is the agent's claim, not proof of one delivery.
 */
export function acknowledge(input: {
  paths: Paths;
  id: string;
  text: string;
}): AsyncResult<Outcome, Failure> {
  const seen: { outcome: ReturnType<typeof parseAcknowledgement> | null } = { outcome: null };
  return DeviceState.acknowledgeSlackEffect(input.paths, input.id, (effect) => {
    const outcome = parseAcknowledgement(
      input.text,
      effect.kind === "reply"
        ? { kind: "reply", channel: effect.channel, threadTs: effect.threadTs }
        : { kind: "reaction", emoji: effect.content },
    );
    seen.outcome = outcome;
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent: the state owner records any outcome that is not done as a failure with its detail
    return outcome.kind === "done" ? outcome : { kind: "failed", detail: outcome.detail };
  })
    .toAsync()
    .flatMap(({ effect, changed }): AsyncResult<Outcome, Failure> => {
      const outcome = seen.outcome;
      if (outcome !== null && outcome.kind !== "done")
        return ErrAsync({
          reason: outcome.kind === "failed" ? "slack_effect_failed" : "slack_ack_unrecognized",
          detail: `${outcome.kind === "failed" ? "Slack refused" : "The result does not show that Slack took"} the ${effect.kind}: ${outcome.detail} The effect stays pending, and the next wait gives it again.`,
        });
      return OkAsync({
        reason: changed ? "slack_effect_done" : "slack_effect_unchanged",
        data: {
          id: effect.id,
          kind: effect.kind,
          state: effect.state,
          channel: effect.channel,
          threadTs: effect.threadTs,
          slackTs: effect.slackTs,
        },
      });
    });
}
