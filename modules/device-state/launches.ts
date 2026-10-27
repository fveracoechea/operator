import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import {
  assignments,
  launches,
  projects,
  reports,
  reviewRequests,
  sources,
  worktreePreparations,
} from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type LaunchRow = typeof launches.$inferSelect;
export type PreparationRow = typeof worktreePreparations.$inferSelect;
export type LaunchFailure =
  | StateFailure
  | {
      reason:
        | "controller_mismatch"
        | "source_not_found"
        | "assignment_not_dispatchable"
        | "launch_name_taken"
        | "launch_not_starting";
      detail: string;
    };
type LaunchResources = Partial<
  Pick<
    LaunchRow,
    "workspaceId" | "tabId" | "paneId" | "worktreePath" | "worktreeWorkspaceId" | "branch"
  >
>;

// The owner renews its lease while it runs. The stale limit also covers a reused process id.
export const leaseRenewMs = 15000;
const leaseStaleMs = 300000;

/** A start or preparation whose owner process is gone, or whose lease is stale, is abandoned. */
export function ownerGone(row: { ownerPid: number | null; leaseAt: string | null }, now: number) {
  if (row.ownerPid === null || row.leaseAt === null) return true;
  if (Date.parse(row.leaseAt) < now - leaseStaleMs) return true;
  try {
    process.kill(row.ownerPid, 0);
    return false;
  } catch (cause) {
    // EPERM means that the process exists under another user.
    return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
  }
}

const abandonedDetail =
  "The dispatching process stopped before it recorded a launch outcome. Its recorded resources stay.";

function endAbandoned(db: ReturnType<typeof drizzle>, id: string, now: number) {
  db.update(launches)
    .set({
      state: "failed",
      endedAt: new Date(now).toISOString(),
      failureReason: "launch_abandoned",
      failureDetail: abandonedDetail,
    })
    .where(and(eq(launches.id, id), eq(launches.state, "starting")))
    .run();
}

/**
 * A ready assignment may start. A running or PR-open one, or a returned report, may start again
 * when its latest start ended or was abandoned.
 */
function dispatchable(
  assignment: string | undefined,
  latest: string | undefined,
  abandoned: boolean,
  returned: boolean,
) {
  if (assignment === "ready") return true;
  return (
    (assignment === "running" ||
      assignment === "pr-open" ||
      (assignment === "reported" && returned)) &&
    (abandoned || latest === "failed" || latest === "interrupted")
  );
}

/** A report that the SuperAgent returned with follow-up needs a worker again. */
function latestReturned(db: ReturnType<typeof drizzle>, sourceId: string, assignment: string) {
  const report = db
    .select({ decision: reports.decision })
    .from(reports)
    .where(and(eq(reports.sourceId, sourceId), eq(reports.assignment, assignment)))
    .orderBy(desc(reports.number))
    .get();
  return report?.decision === "returned";
}

/** Reserve the assignment before any external effect, so a second dispatch cannot start it. */
export function reserveLaunch(
  client: Database,
  checkout: string,
  repository: string,
  launch: Omit<LaunchRow, "attempt" | "ownerPid" | "leaseAt">,
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<LaunchRow, LaunchFailure> => {
      const controller = db
        .select()
        .from(projects)
        .where(eq(projects.repository, repository))
        .get();
      if (controller?.checkout !== checkout)
        return Err({
          reason: "controller_mismatch",
          detail: "The controlling checkout changed before dispatch. Read the project again.",
        });
      const source = db
        .select()
        .from(sources)
        .where(and(eq(sources.id, launch.sourceId), eq(sources.repository, repository)))
        .get();
      if (source === undefined)
        return Err({
          reason: "source_not_found",
          detail: "The source does not exist in this project.",
        });
      const assignment = db
        .select()
        .from(assignments)
        .where(and(eq(assignments.sourceId, source.id), eq(assignments.key, launch.assignment)))
        .get();
      const latest = db
        .select()
        .from(launches)
        .where(and(eq(launches.sourceId, source.id), eq(launches.assignment, launch.assignment)))
        .orderBy(desc(launches.attempt))
        .get();
      const now = Date.now();
      const abandoned = latest?.state === "starting" && ownerGone(latest, now);
      const returned = latestReturned(db, source.id, launch.assignment);
      if (
        source.state !== "open" ||
        !dispatchable(assignment?.state, latest?.state, abandoned, returned)
      )
        return Err({
          reason: "assignment_not_dispatchable",
          detail: `Assignment ${launch.assignment} changed before dispatch. Read next actions again. Nothing was launched.`,
        });
      if (db.select().from(launches).where(eq(launches.name, launch.name)).get())
        return Err({
          reason: "launch_name_taken",
          detail: `The launch name ${launch.name} is already recorded. Nothing was launched.`,
        });
      // The latest launch has the highest attempt number.
      const attempt = (latest?.attempt ?? 0) + 1;
      if (abandoned) endAbandoned(db, latest.id, now);
      const row = {
        ...launch,
        attempt,
        ownerPid: process.pid,
        leaseAt: new Date(now).toISOString(),
      };
      db.insert(launches).values(row).run();
      // A replaced PR owner keeps its open PR. A returned report resumes as running.
      db.update(assignments)
        .set({ state: "running" })
        .where(
          and(
            eq(assignments.sourceId, source.id),
            eq(assignments.key, launch.assignment),
            inArray(assignments.state, ["ready", "reported"]),
          ),
        )
        .run();
      return Ok(row);
    }),
  );
}

/** Record each returned Herdr resource as soon as it exists, then the final launch outcome. */
export function updateLaunch(
  client: Database,
  id: string,
  change: LaunchResources & {
    state?: "running" | "failed";
    failureReason?: string;
    failureDetail?: string;
  },
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<LaunchRow, LaunchFailure> => {
      const current = db.select().from(launches).where(eq(launches.id, id)).get();
      if (current?.state !== "starting")
        return Err({
          reason: "launch_not_starting",
          detail: "Only a starting launch can record resources or its launch outcome.",
        });
      const now = new Date().toISOString();
      const endedAt = change.state === "failed" ? now : null;
      db.update(launches)
        .set({ ...change, endedAt, leaseAt: now })
        .where(eq(launches.id, id))
        .run();
      return Ok({ ...current, ...change, endedAt, leaseAt: now });
    }),
  );
}

/** Renew the lease of a start that this process owns. */
export function renewLaunch(client: Database, id: string) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(launches)
        .set({ leaseAt: new Date().toISOString() })
        .where(
          and(
            eq(launches.id, id),
            eq(launches.state, "starting"),
            eq(launches.ownerPid, process.pid),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

export function launchNames(client: Database) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => [
      ...db
        .select({ name: launches.name })
        .from(launches)
        .all()
        .map((row) => row.name),
      // Reviewer launches share the Herdr name space with worker launches.
      ...db
        .select({ name: reviewRequests.name })
        .from(reviewRequests)
        .all()
        .flatMap((row) => (row.name === null ? [] : [row.name])),
    ]),
  );
}

/**
 * A pane exit interrupts its starting or running launch. Activity is retained only as an
 * observation, because Herdr activity never proves a submitted or completed result.
 * Most pane events on the device match no launch, so they open no write transaction.
 */
export function observePane(
  client: Database,
  input: {
    socket: string | null;
    paneId: string;
    workspaceId: string | null;
    observation: { exited: true } | { exited: false; activity: string };
  },
) {
  const matching = and(
    eq(launches.paneId, input.paneId),
    input.socket === null ? isNull(launches.herdrSocket) : eq(launches.herdrSocket, input.socket),
    inArray(launches.state, ["starting", "running"]),
  );
  // Only an exit changes a reviewer. Its activity is not recorded.
  const reviewer = and(
    eq(reviewRequests.paneId, input.paneId),
    input.socket === null
      ? isNull(reviewRequests.herdrSocket)
      : eq(reviewRequests.herdrSocket, input.socket),
    eq(reviewRequests.launchState, "running"),
  );
  return transaction(client, false, () =>
    checkHistory(client).map(
      (db) =>
        db.select({ id: launches.id }).from(launches).where(matching).all().length > 0 ||
        (input.observation.exited &&
          db.select({ id: reviewRequests.id }).from(reviewRequests).where(reviewer).all().length >
            0),
    ),
  ).flatMap((found) =>
    found
      ? writeObservation(client, matching, reviewer, input)
      : Ok({ launches: [], reviewers: [] }),
  );
}

function writeObservation(
  client: Database,
  matching: ReturnType<typeof and>,
  reviewer: ReturnType<typeof and>,
  input: Parameters<typeof observePane>[1],
) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      const now = new Date().toISOString();
      const matched = db.select({ id: launches.id }).from(launches).where(matching).all();
      if (matched.length > 0)
        db.update(launches)
          .set(
            input.observation.exited
              ? {
                  state: "interrupted",
                  endedAt: now,
                  failureReason: "pane_ended",
                  failureDetail: `Herdr reported that pane ${input.paneId} exited or closed before the assignment completed.`,
                }
              : { activity: input.observation.activity, activityAt: now },
          )
          .where(matching)
          .run();
      // A reviewer whose pane ended needs a replacement. Its worktree and rounds stay.
      const reviewers = input.observation.exited
        ? db
            .update(reviewRequests)
            .set({ launchState: "interrupted" })
            .where(reviewer)
            .returning({ id: reviewRequests.id })
            .all()
        : [];
      return {
        launches: matched.map((row) => row.id),
        reviewers: reviewers.map((row) => row.id),
      };
    }),
  );
}

export function beginPreparation(client: Database, path: string, repository: string) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap(
      (
        db,
      ): Result<
        PreparationRow,
        StateFailure | { reason: "preparation_running"; detail: string }
      > => {
        const current = db
          .select()
          .from(worktreePreparations)
          .where(eq(worktreePreparations.path, path))
          .get();
        if (current?.state === "running" && !ownerGone(current, Date.now()))
          return Err({
            reason: "preparation_running",
            detail: `Another preparation of ${path} is still running.`,
          });
        const now = new Date().toISOString();
        const row = {
          path,
          repository,
          state: "running",
          detail: "Preparation started.",
          startedAt: now,
          finishedAt: null,
          ownerPid: process.pid,
          leaseAt: now,
        };
        db.insert(worktreePreparations)
          .values(row)
          .onConflictDoUpdate({ target: worktreePreparations.path, set: row })
          .run();
        return Ok(row);
      },
    ),
  );
}

export function finishPreparation(
  client: Database,
  path: string,
  outcome: { state: "prepared" | "failed"; detail: string },
) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(worktreePreparations)
        .set({ ...outcome, finishedAt: new Date().toISOString() })
        .where(and(eq(worktreePreparations.path, path), eq(worktreePreparations.state, "running")))
        .run();
      return outcome;
    }),
  );
}

/** Renew the lease of a preparation that this process owns. */
export function renewPreparation(client: Database, path: string) {
  return transaction(client, true, () =>
    checkHistory(client).map((db) => {
      db.update(worktreePreparations)
        .set({ leaseAt: new Date().toISOString() })
        .where(
          and(
            eq(worktreePreparations.path, path),
            eq(worktreePreparations.state, "running"),
            eq(worktreePreparations.ownerPid, process.pid),
          ),
        )
        .run();
      return undefined;
    }),
  );
}

/** A running preparation whose hook process stopped is reported as abandoned. */
export function readPreparation(client: Database, path: string) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => {
      const row = db
        .select()
        .from(worktreePreparations)
        .where(eq(worktreePreparations.path, path))
        .get();
      return row === undefined
        ? null
        : { ...row, abandoned: row.state === "running" && ownerGone(row, Date.now()) };
    }),
  );
}
