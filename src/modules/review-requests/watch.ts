import { Ok, fromPromise } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { readPullRequest, type Target } from "./github.ts";
import { reviewAction } from "./review-machine.ts";
import {
  apply,
  latestPosted,
  qualify,
  roundNumber,
  summary,
  type Paths,
  type Row,
  type Snapshot,
} from "./request.ts";
import { cleanupResult, cleanupReviewer, failureOf, syncReviewer } from "./reviewer.ts";
import { decideWatch, type WatchDecision } from "./rounds.ts";
import type { NextStep } from "../../lib/cli-result.ts";

type Listed = Snapshot;
type Event = { url: string; kind: string } & Record<string, unknown>;
export type ReviewScope = { repository: string; sourceIds?: readonly string[]; manual?: boolean };

function inScope(listed: Listed[], scopes: readonly ReviewScope[]) {
  return listed.filter(
    ({ request }) =>
      request !== null &&
      scopes.some(
        (scope) =>
          scope.repository === request.repository &&
          (request.sourceId === null
            ? scope.manual !== false
            : scope.sourceIds === undefined || scope.sourceIds.includes(request.sourceId)),
      ),
  );
}

function targetOf(request: Row): Target {
  return { repository: request.repository, number: request.number, url: request.url };
}

const threadIds = z.array(z.string());

/** One request's rows for next: an action, an attention, or a wait, from recorded state alone. */
export function rows(paths: Paths, listed: Snapshot[]) {
  return listed.flatMap((row) => {
    const request = row.request;
    if (request === null) return [];
    const step = reviewAction(request, row.ownerActive);
    const commands: Record<
      Extract<ReturnType<typeof reviewAction>, { kind: "action" }>["action"],
      string
    > = {
      start_reviewer: `operator review start ${request.url}`,
      replace_reviewer: `operator review start ${request.url}`,
      post_review: `operator review post ${request.url}`,
      wait_reviews: "operator next --wait",
      clean_reviewer: `operator review cleanup ${request.url}`,
    };
    const posted = latestPosted(row.rounds);
    const reply =
      request.slackThread !== null &&
      posted !== null &&
      ["watching", "approved"].includes(request.state)
        ? `Reply once in ${request.slackThread} with one short status line for review round ${posted.number} (${posted.reviewUrl}). Use your own tools, with no draft. Operator records no acknowledgement or retry.`
        : null;
    const why = reply === null ? step.reason : `${step.reason}. ${reply}`;
    const next: NextStep =
      step.kind === "action"
        ? { command: commands[step.action], why }
        : step.kind === "attention"
          ? {
              decider: step.reason === "reviewer_work_kept" ? "person" : "super-agent",
              question:
                `What intervention does this review need for ${step.reason}? ${reply ?? ""}`.trim(),
            }
          : reply === null
            ? { command: "operator next --wait", why }
            : { decider: "super-agent", question: reply };
    return [
      {
        ...summary(paths, row),
        next,
        ...(step.kind === "action"
          ? { action: step.action, reason: step.reason, command: next.command }
          : step.kind === "attention"
            ? { attention: step.reason }
            : { wait: step.reason, command: next.command }),
      },
    ];
  });
}

/** A running reviewer that Herdr no longer lists in this server is interrupted. */
async function checkReviewers(paths: Paths, listed: Listed[]) {
  const socket = Environment.read().HERDR_SOCKET_PATH ?? null;
  const running = listed.flatMap(({ request }) =>
    request?.launchState === "running" && request.herdrSocket === socket ? [request] : [],
  );
  if (running.length === 0) return [];
  const agents = await Herdr.agentNames();
  if (agents.tag !== "Ok") return [];
  const events: Event[] = [];
  for (const request of running) {
    if (agents.value.some((name) => name === request.name)) continue;
    const changed = DeviceState.changeReviewRequest(
      paths,
      { ...targetOf(request), id: request.id },
      (current) =>
        Ok(
          // Stryker disable next-line OptionalChaining: equivalent: the change reads the listed request by its id, so it always exists
          current.request?.launchState === "running"
            ? { update: { launchState: "interrupted" } }
            : {},
        ),
    );
    if (changed.tag === "Ok") events.push({ url: request.url, kind: "reviewer_interrupted" });
  }
  return events;
}

/** The flag is set once, so a second wait reports nothing. A round start clears it. */
function markStale(paths: Paths, target: Target, request: Row, now: number): Event[] {
  // Stryker disable next-line ObjectLiteral, BooleanLiteral: equivalent: the change decision always sets the flag before a successful write reads it
  const changed = { stale: false };
  const marked = DeviceState.changeReviewRequest(
    paths,
    { ...target, id: request.id },
    (current) => {
      // Stryker disable next-line OptionalChaining: equivalent: the change reads the listed request by its id, so it always exists
      changed.stale = current.request?.state === "watching" && current.request.staleAt === null;
      return Ok(changed.stale ? { update: { staleAt: new Date(now).toISOString() } } : {});
    },
  );
  return marked.tag === "Ok" && changed.stale ? [{ url: request.url, kind: "review_stale" }] : [];
}

async function close(paths: Paths, target: Target, request: Row, prState: string) {
  const closed = apply(paths, target, "close", undefined, { id: request.id });
  // An end that the request refuses, such as during a live start, waits for a later read.
  if (closed.tag !== "Ok") return [];
  const cleaned = await cleanupReviewer(paths, target, closed.value.snapshot);
  return [
    {
      url: request.url,
      kind: "review_closed",
      prState,
      cleanup: cleanupResult(cleaned),
    },
  ];
}

/** Starts a round or records a head move, and gives it to the running reviewer. */
async function advance(
  paths: Paths,
  target: Target,
  request: Row,
  decision: Extract<WatchDecision, { kind: "round" | "head_moved" }>,
): Promise<Event[]> {
  const applied =
    decision.kind === "round"
      ? apply(paths, target, "round", undefined, {
          id: request.id,
          trigger: decision.trigger,
          to: decision.head,
        })
      : apply(paths, target, "head_moved", undefined, {
          id: request.id,
          observedFrom: decision.from,
          to: decision.to,
        });
  // Another wait that applied this observation first leaves nothing to report here.
  if (applied.tag !== "Ok" || applied.value.transition.unchanged === true) return [];
  const event: Event =
    decision.kind === "round"
      ? {
          url: request.url,
          kind: "round_started",
          requestId: request.id,
          round: roundNumber(applied.value.snapshot.rounds),
          head: decision.head,
          trigger: decision.trigger,
        }
      : { url: request.url, kind: "head_moved", from: decision.from, to: decision.to };
  if (applied.value.transition.sync !== true) return [event];
  const synced = await syncReviewer(paths, target, applied.value.snapshot);
  return [
    {
      ...event,
      reviewer: synced.tag === "Ok" ? synced.value : { kind: "failed", ...failureOf(synced) },
    },
  ];
}

/** Observes one request on GitHub and applies what the read means. */
async function observe(paths: Paths, row: Listed, now: number): Promise<Event[]> {
  const request = row.request;
  if (request === null || ["closed", "skipped", "posting"].includes(request.state)) return [];
  const target = targetOf(request);
  const read = await readPullRequest(target);
  if (read.tag !== "Ok") return [{ url: request.url, kind: "read_failed", ...failureOf(read) }];
  const decision = decideWatch({
    state: request.state,
    head: request.head,
    since: request.activityAt ?? request.requestedAt,
    postedAt: latestPosted(row.rounds)?.postedAt ?? null,
    resolvedThreads: threadIds.parse(JSON.parse(request.resolvedThreads ?? "[]")),
    staleAt: request.staleAt,
    pr: read.value,
    now,
  });
  if (decision.kind === "none") return [];
  if (decision.kind === "stale") return markStale(paths, target, request, now);
  if (decision.kind === "close") return close(paths, target, request, read.value.state);
  return advance(paths, target, request, decision);
}

/** A sync or a cleanup whose process stopped is finished by the next wait. */
async function resume(paths: Paths, row: Listed): Promise<Event[]> {
  const request = row.request;
  if (request === null || row.ownerActive) return [];
  const target = targetOf(request);
  // A failed move is retried by every wait, and only a new failure is reported again.
  if (request.sync !== null) {
    const claimed = apply(paths, target, "sync", undefined, { id: request.id });
    if (claimed.tag !== "Ok" || claimed.value.transition.lease !== "hold") return [];
    const synced = await syncReviewer(paths, target, claimed.value.snapshot);
    if (synced.tag === "Ok")
      return [{ url: request.url, kind: "reviewer_synced", reviewer: synced.value }];
    const failure = failureOf(synced);
    return failure.reason === request.failureReason
      ? []
      : [{ url: request.url, kind: "reviewer_synced", reviewer: { kind: "failed", ...failure } }];
  }
  if (request.cleanupState === "pending") {
    const claimed = DeviceState.changeReviewRequest(
      paths,
      { ...target, id: request.id },
      (current) =>
        Ok(
          // Stryker disable next-line OptionalChaining: equivalent: the change reads the listed request by its id, so it always exists
          current.request?.cleanupState === "pending" && !current.ownerActive
            ? { lease: "hold" as const }
            : {},
        ),
    );
    // Stryker disable next-line OptionalChaining: equivalent: the change reads the listed request by its id, so it always exists
    if (claimed.tag !== "Ok" || claimed.value.request?.ownerPid !== process.pid) return [];
    const cleaned = await cleanupReviewer(paths, target, claimed.value);
    return [
      {
        url: request.url,
        kind: "reviewer_cleaned",
        cleanup: cleanupResult(cleaned),
      },
    ];
  }
  return [];
}

function pass(paths: Paths, scopes: readonly ReviewScope[]) {
  return DeviceState.readReviewRequests(paths)
    .map((listed) => inScope(listed, scopes))
    .toAsync()
    .flatMap((listed) =>
      fromPromise(async () => {
        const events = await checkReviewers(paths, listed);
        const now = Date.now();
        for (const row of listed)
          events.push(...(await resume(paths, row)), ...(await observe(paths, row, now)));
        return events;
      }, qualify),
    )
    .flatMap((events) =>
      DeviceState.readReviewRequests(paths).map((after) => ({
        events,
        listed: inScope(after, scopes),
      })),
    );
}

/** One coordination poll owns review upkeep. Quiet reads add no event. */
export function upkeep(input: { paths: Paths; scopes: readonly ReviewScope[]; observe?: boolean }) {
  const read =
    input.observe === false
      ? DeviceState.readReviewRequests(input.paths)
          .toAsync()
          .map((listed) => ({ events: [] as Event[], listed: inScope(listed, input.scopes) }))
      : pass(input.paths, input.scopes);
  return read.map(({ events, listed }) => ({ events, requests: rows(input.paths, listed) }));
}
