// Bun has no path API.
import path from "node:path";
import { Err, ErrAsync, Ok, OkAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { renderReviewerBrief } from "./brief.ts";
import type { Target } from "./github.ts";
import {
  apply,
  files,
  parseSync,
  qualify,
  record,
  roundNumber,
  type Failure,
  type Paths,
  type Row,
  type Snapshot,
  type Sync,
} from "./request.ts";

function slug(text: string) {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/** Writes each posted round's draft beside the brief, so a replacement reads the history. */
async function writeHistory(paths: Paths, snapshot: Pick<Snapshot, "request" | "rounds">) {
  const request = snapshot.request;
  if (request === null) return [];
  const directory = files(paths, request).rounds;
  const history = [];
  for (const round of snapshot.rounds.filter((row) => row.outcome === "posted")) {
    const draft = path.join(directory, `${round.number}.json`);
    await Bun.write(draft, `${round.draft}\n`, { createPath: true });
    history.push({
      number: round.number,
      trigger: round.trigger,
      reviewedCommit: round.reviewedCommit,
      event: round.event,
      url: round.reviewUrl,
      draft,
    });
  }
  return history;
}

function briefText(
  paths: Paths,
  request: Row,
  placement: { worktree: string; branch: string },
  history: Awaited<ReturnType<typeof writeHistory>>,
  rounds: Snapshot["rounds"],
) {
  return renderReviewerBrief({
    url: request.url,
    repository: request.repository,
    number: request.number,
    origin: request.origin,
    head: request.head ?? "",
    worktree: placement.worktree,
    branch: placement.branch,
    draft: files(paths, request).draft,
    round: { number: roundNumber(rounds), trigger: request.trigger ?? "first" },
    history,
  });
}

/**
 * Starts the reviewer, or its replacement, in the PR repository's Herdr workspace. A
 * replacement reopens the recorded worktree at the recorded head, and its brief names every
 * earlier round with its draft.
 */
export function launch(
  input: { paths: Paths; profile?: string },
  target: Target,
  snapshot: Snapshot,
  replace: boolean,
) {
  const request = snapshot.request;
  const project = snapshot.project;
  if (request === null || project === null || request.head === null)
    return ErrAsync<Failure>({ reason: "review_defect", detail: "The start lost its request." });
  const name = slug(target.repository.split("/").at(-1) ?? "");
  const brief = files(input.paths, request).brief;
  return fromPromise(() => writeHistory(input.paths, snapshot), qualify).flatMap((history) =>
    WorkerDispatch.launchReviewer({
      paths: input.paths,
      checkout: project.checkout,
      repository: target.repository,
      number: target.number,
      head: request.head ?? "",
      exactHead: !replace,
      nameBase: `${name}-pr${target.number}-review`.slice(0, 28).replace(/-+$/, ""),
      branchBase: `review/${name}-pr-${target.number}`,
      profile: input.profile,
      reuse:
        request.worktreePath === null || request.branch === null
          ? null
          : { path: request.worktreePath, branch: request.branch },
      brief: {
        file: brief,
        render: (placement) => briefText(input.paths, request, placement, history, snapshot.rounds),
      },
      record: (change) => record(input.paths, target, request.id, { update: change }),
    }),
  );
}

const triggerText: Record<string, string> = {
  commits: "new commits",
  reply: "an author reply",
  resolved: "a thread that the author resolved",
  "re-request": "a renewed review request",
};

function prompt(request: Row, sync: Sync, brief: string, mode: string | null) {
  if (sync.kind === "round")
    return `Review round ${sync.round} of PR #${request.number} started, because of ${triggerText[sync.trigger] ?? sync.trigger}. Your worktree is at ${request.head}. Read the brief ${brief} again, check each of your open review threads, and write a new draft for ${request.head}.`;
  const round =
    sync.round === undefined
      ? ""
      : `Review round ${sync.round} of PR #${request.number} started, because of ${triggerText[sync.trigger ?? "commits"] ?? sync.trigger}. `;
  return mode === "fast-forward"
    ? `${round}PR #${request.number} moved from ${sync.from} to ${sync.to} by a fast-forward. Your worktree is now at ${sync.to}. Review only the new commits: run git log ${sync.from}..${sync.to} and git diff ${sync.from}..${sync.to}. Check each of your open review threads. Then write a draft for ${sync.to} and post it. The brief is ${brief}.`
    : `${round}PR #${request.number} was force-pushed from ${sync.from} to ${sync.to}. Your worktree is now at ${sync.to}. Review the PR again from the start, check each of your open review threads, then write a draft for ${sync.to} and post it. The brief is ${brief}.`;
}

type Synced = { kind: string; mode: string | null };

function failureOf(result: { tag: string; error?: Failure; cause?: unknown }): Failure {
  return result.error ?? { reason: "review_defect", detail: String(result.cause) };
}

/**
 * Gives a decided move or round to the running reviewer, while this process holds the lease:
 * it moves the worktree, writes the brief again, and prompts the same reviewer. A prompt that
 * Herdr refuses marks the reviewer interrupted, so next offers a replacement. A failed move
 * keeps the sync for the next wait and shows the failure.
 */
export function syncReviewer(
  paths: Paths,
  target: Target,
  snapshot: Snapshot,
): AsyncResult<Synced, Failure> {
  const request = snapshot.request;
  const project = snapshot.project;
  const sync = parseSync(request?.sync ?? null);
  if (request === null || project === null || sync === null)
    return OkAsync({ kind: "none", mode: null });
  const exact = { ...target, id: request.id };
  return fromPromise(async () => {
    const release = DeviceState.holdReviewRequest(paths, request.id);
    try {
      let mode: string | null = null;
      if (sync.kind === "head" && request.worktreePath !== null) {
        const moved = await WorkerDispatch.moveReviewer({
          checkout: project.checkout,
          repository: target.repository,
          number: target.number,
          worktree: request.worktreePath,
          from: sync.from,
          to: sync.to,
        });
        if (moved.tag !== "Ok") {
          const error = failureOf(moved);
          const kept = apply(
            paths,
            exact,
            "synced",
            () => ({ update: { failureReason: error.reason, failureDetail: error.detail } }),
            { id: request.id },
          );
          return kept.tag === "Ok" ? Err(error) : kept.map(() => ({ kind: "none", mode: null }));
        }
        mode = moved.value.mode;
      }
      const history = await writeHistory(paths, snapshot);
      const brief = files(paths, request).brief;
      await Bun.write(
        brief,
        briefText(
          paths,
          request,
          { worktree: request.worktreePath ?? "", branch: request.branch ?? "" },
          history,
          snapshot.rounds,
        ),
        { createPath: true },
      );
      const prompted =
        (await Herdr.prompt({ name: request.name ?? "", text: prompt(request, sync, brief, mode) }))
          .tag === "Ok";
      return apply(
        paths,
        exact,
        "synced",
        () => ({
          update: {
            sync: null,
            failureReason: null,
            failureDetail: null,
            launchState: prompted ? request.launchState : "interrupted",
          },
        }),
        { id: request.id },
      ).map(() => ({ kind: prompted ? sync.kind : "reviewer_interrupted", mode }));
    } finally {
      release();
    }
  }, qualify).flatMap((result) => result);
}

type CleanupOutcome = { state: "done" | "kept" | "failed"; detail: string };

/** Closes the reviewer pane only in its Herdr server, and only while it holds this reviewer. */
async function closePane(request: Row): Promise<CleanupOutcome | string> {
  if (request.paneId === null) return "No reviewer pane was recorded.";
  if (Environment.read().HERDR_SOCKET_PATH !== (request.herdrSocket ?? undefined))
    return {
      state: "failed",
      detail: `Pane ${request.paneId} belongs to another Herdr server. Run operator review cleanup in a pane of that server.`,
    };
  const agents = await Herdr.agentNames();
  if (agents.tag !== "Ok")
    return {
      state: "failed",
      detail: agents.tag === "Err" ? agents.error.detail : String(agents.cause),
    };
  if (request.name === null || !agents.value.includes(request.name))
    return `Pane ${request.paneId} no longer holds ${request.name ?? "the reviewer"}.`;
  const closed = await Herdr.closePane(request.paneId);
  if (closed.tag !== "Ok")
    return {
      state: "failed",
      detail: closed.tag === "Err" ? closed.error.detail : String(closed.cause),
    };
  return `Closed pane ${request.paneId}.`;
}

async function dispose(request: Row, checkout: string): Promise<CleanupOutcome> {
  const pane = await closePane(request);
  if (typeof pane !== "string") return pane;
  if (request.worktreePath === null) return { state: "done", detail: pane };
  const worktree = await WorkerDispatch.cleanWorktree({
    checkout,
    worktree: request.worktreePath,
    branch: request.branch,
  }).catch((cause: unknown) => ({ state: "failed" as const, detail: String(cause) }));
  if (worktree.state === "failed") return worktree;
  return {
    state: worktree.state === "kept" ? "kept" : "done",
    detail: `${pane} ${worktree.detail}`,
  };
}

/**
 * Disposes the reviewer of a closed or skipped request while this process holds the lease. The
 * worktree and its local branch go only when Git proves that they hold no unlanded work, and a
 * failure stays recorded until a repeated cleanup finishes.
 */
export function cleanupReviewer(paths: Paths, target: Target, snapshot: Snapshot) {
  const request = snapshot.request;
  const project = snapshot.project;
  if (request === null || project === null)
    return ErrAsync<Failure>({
      reason: "review_defect",
      detail: "The cleanup lost its request.",
    });
  const release = DeviceState.holdReviewRequest(paths, request.id);
  return fromPromise(async () => {
    try {
      return await dispose(request, project.checkout);
    } finally {
      release();
    }
  }, qualify).flatMap((outcome) =>
    DeviceState.changeReviewRequest(paths, { ...target, id: request.id }, () =>
      Ok({
        update: { cleanupState: outcome.state, cleanupDetail: outcome.detail },
        lease: "release" as const,
      }),
    ).map(() => outcome),
  );
}

/** A refusal for a cleanup that another process runs, or that has nothing left to do. */
export function claimCleanup(paths: Paths, target: Target, id: string) {
  return DeviceState.changeReviewRequest(paths, { ...target, id }, (current) => {
    const state = current.request?.cleanupState ?? null;
    if (state === null || state === "done")
      return Err<Failure>({
        reason: "review_cleanup_unchanged",
        detail: "The reviewer cleanup is done.",
      });
    if (current.ownerActive)
      return Err<Failure>({
        reason: "review_cleanup_in_progress",
        detail: "Another process cleans up this reviewer now. Nothing changed.",
      });
    return Ok({ lease: "hold" as const });
  });
}
