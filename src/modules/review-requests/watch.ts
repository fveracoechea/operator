import { Ok, OkAsync, fromPromise, type AsyncResult } from "unthrown";
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
  summary,
  type Failure,
  type Outcome,
  type Paths,
  type Row,
  type Snapshot,
} from "./request.ts";
import { cleanupResult, cleanupReviewer, failureOf, syncReviewer } from "./reviewer.ts";
import { decideWatch, type WatchDecision } from "./rounds.ts";
import type { NextStep } from "../../lib/cli-result.ts";

const pollMs = 30000;
type Listed = Snapshot;
type Event = { url: string; kind: string } & Record<string, unknown>;

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
      wait_reviews: "operator review wait",
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
            ? { command: "operator review wait", why }
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
      ? { url: request.url, kind: "round_started", trigger: decision.trigger }
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

function pass(paths: Paths) {
  return DeviceState.readReviewRequests(paths)
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
      DeviceState.readReviewRequests(paths).map((after) => ({ events, listed: after })),
    );
}

type Loop = { paths: Paths; deadline: number; first: boolean; all: boolean };

/** The requests that the wait returns: those its events name and those with an action. */
function shown(requests: ReturnType<typeof rows>, events: Event[], all: boolean) {
  if (all) return requests;
  const named = new Set(events.map((event) => event.url));
  return requests.filter((row) => (row.url !== undefined && named.has(row.url)) || "action" in row);
}

function poll(loop: Loop): AsyncResult<Outcome, Failure> {
  const { paths, deadline, first } = loop;
  return pass(paths).flatMap(({ events, listed }): AsyncResult<Outcome, Failure> => {
    const listedRows = rows(paths, listed);
    const requests = shown(listedRows, events, loop.all);
    if (events.length > 0)
      return OkAsync({ reason: "review_events_observed", data: { events, requests } });
    // Only the first pass returns for an action, so a row that waits for the SuperAgent or the
    // person does not turn repeated waits into a busy loop. A wait finishes moves by itself.
    if (first && listedRows.some((row) => "action" in row && row.action !== "wait_reviews"))
      return OkAsync({ reason: "review_actions_ready", data: { events, requests } });
    if (Date.now() >= deadline)
      return OkAsync({ reason: "review_wait_timed_out", data: { events, requests } });
    return fromPromise(() => Bun.sleep(Math.min(pollMs, deadline - Date.now())), qualify).flatMap(
      () => poll({ ...loop, first: false }),
    );
  });
}

/**
 * Observes every open review request until one changes or an action waits for the SuperAgent,
 * or the timeout passes. It moves reviewers to new heads, starts rounds, marks stale requests,
 * and ends closed PRs inside the loop. Each change is a guarded transition, so two waits never
 * apply the same observation twice. Without `all`, it
 * returns only the requests that its events name and those with an action.
 */
export function wait(input: { paths: Paths; timeoutSeconds: number; all?: boolean }) {
  return poll({
    paths: input.paths,
    deadline: Date.now() + input.timeoutSeconds * 1000,
    first: true,
    all: input.all === true,
  });
}
