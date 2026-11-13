import { asc, eq, inArray, or } from "drizzle-orm";
import { Err, Ok, type Result } from "unthrown";
import type { Database } from "bun:sqlite";
import { checkHistory, transaction, type Db } from "./database.ts";
import { cleanups, projectRemovals, projects, reviewRequests, sources } from "./schema.ts";
import { deleteSourceRecords } from "./sources.ts";
import type { StateFailure } from "./failures.ts";

export type RegisteredProject = typeof projects.$inferSelect;
export type ProjectStateFailure =
  | StateFailure
  | {
      reason:
        | "project_not_registered"
        | "project_source_open"
        | "project_cleanup_open"
        | "project_review_open"
        | "project_cleanup_pending";
      detail: string;
    };
export type Registration = {
  reason: "project_registered" | "project_unchanged";
  data: RegisteredProject;
};

function hasOpenSource(db: Db, repository: string) {
  return db
    .select()
    .from(sources)
    .where(eq(sources.repository, repository))
    .all()
    .some((source) => !["finished", "reset"].includes(source.state) || source.endedAt === null);
}

// A failed cleanup outlives its finished source. Removal or a move would hide or misdirect it.
function openCleanup(db: Db, repository: string) {
  const ids = db.select({ id: sources.id }).from(sources).where(eq(sources.repository, repository));
  return db
    .select()
    .from(cleanups)
    .where(inArray(cleanups.sourceId, ids))
    .all()
    .some((cleanup) => cleanup.state !== "done");
}

// A review request holds a reviewer pane and worktree until it ends and its cleanup finishes.
// The project row's foreign key would delete it, and a move would misdirect its cleanup.
function openReview(db: Db, repository: string) {
  return db
    .select()
    .from(reviewRequests)
    .where(eq(reviewRequests.repository, repository))
    .all()
    .some(
      (request) =>
        !["closed", "skipped"].includes(request.state) ||
        ["pending", "failed", "kept"].includes(request.cleanupState ?? ""),
    );
}

const reviewOpen = {
  reason: "project_review_open" as const,
  detail:
    "Finish every review request of this project first: close or skip it, and finish its reviewer cleanup. Read operator review next for it.",
};

const cleanupOpen = {
  reason: "project_cleanup_open" as const,
  detail: "Finish every open cleanup with operator cleanup first. Read operator next for it.",
};

export function registerProject(client: Database, project: RegisteredProject) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<Registration, ProjectStateFailure> => {
      if (
        db
          .select()
          .from(projectRemovals)
          .where(eq(projectRemovals.repository, project.repository))
          .get()
      )
        return Err({
          reason: "project_cleanup_pending",
          detail: `Finish project remove ${project.repository} before registering it again.`,
        });
      const existing = db
        .select()
        .from(projects)
        .where(
          or(eq(projects.repository, project.repository), eq(projects.checkout, project.checkout)),
        )
        .all();
      const byPath = existing.find((row) => row.checkout === project.checkout);
      if (byPath && byPath.repository !== project.repository)
        return Err<StateFailure>({
          reason: "controller_identity_mismatch",
          detail: `This checkout is recorded as ${byPath.repository}. Restore its remote identity before use. It was not re-registered as ${project.repository}.`,
        });
      // Stryker disable next-line ConditionalExpression: equivalent: a checkout row of another identity returned above, so at most one row remains and it is this identity's
      const byIdentity = existing.find((row) => row.repository === project.repository);
      if (byIdentity && byIdentity.checkout !== project.checkout)
        return Err<StateFailure>({
          reason: "controller_mismatch",
          detail: `Use the recorded controlling checkout at ${byIdentity.checkout}. To change it, run operator project move from a matching main clone when no source is open.`,
        });
      if (byIdentity) return Ok({ reason: "project_unchanged" as const, data: byIdentity });
      db.insert(projects).values(project).run();
      return Ok({ reason: "project_registered" as const, data: project });
    }),
  );
}

export function lookupProject(client: Database, checkout: string, repositories: string[]) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => ({
      controller: db.select().from(projects).where(eq(projects.checkout, checkout)).get(),
      matches: db.select().from(projects).where(inArray(projects.repository, repositories)).all(),
    })),
  );
}

export function listProjects(client: Database) {
  return transaction(client, false, () =>
    checkHistory(client).map((db) => ({
      projects: db
        .select()
        .from(projects)
        .orderBy(asc(projects.repository))
        .all()
        .map((project) => ({
          ...project,
          openSources: db
            .select()
            .from(sources)
            .where(eq(sources.repository, project.repository))
            .all()
            .filter((source) => source.state === "open").length,
        })),
      pendingRemovals: db
        .select()
        .from(projectRemovals)
        .orderBy(asc(projectRemovals.repository))
        .all(),
    })),
  );
}

export function removeProject(client: Database, repository: string) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<void, ProjectStateFailure> => {
      if (db.select().from(projectRemovals).where(eq(projectRemovals.repository, repository)).get())
        return Ok(undefined);
      const project = db.select().from(projects).where(eq(projects.repository, repository)).get();
      if (!project)
        return Err({
          reason: "project_not_registered",
          detail: "This identity is not registered and has no pending removal.",
        });
      const held = hasOpenSource(db, repository);
      if (held)
        return Err({
          reason: "project_source_open",
          detail: "End every open source before removing this project.",
        });
      if (openCleanup(db, repository)) return Err(cleanupOpen);
      if (openReview(db, repository)) return Err(reviewOpen);
      deleteSourceRecords(
        db,
        db
          .select({ id: sources.id })
          .from(sources)
          .where(eq(sources.repository, repository))
          .all()
          .map((source) => source.id),
      );
      // The project row's foreign key deletes its worktree preparations and review requests.
      db.insert(projectRemovals).values({ repository, removedAt: new Date().toISOString() }).run();
      db.delete(projects).where(eq(projects.repository, repository)).run();
      return Ok(undefined);
    }),
  );
}

export function moveProject(client: Database, repository: string, checkout: string) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap(
      (db): Result<{ reason: "project_moved"; data: RegisteredProject }, ProjectStateFailure> => {
        const byPath = db.select().from(projects).where(eq(projects.checkout, checkout)).get();
        if (byPath && byPath.repository !== repository)
          return Err({
            reason: "controller_identity_mismatch",
            detail: `This checkout is already recorded as ${byPath.repository}. Its identity was not changed.`,
          });
        const project = db.select().from(projects).where(eq(projects.repository, repository)).get();
        if (!project)
          return Err({
            reason: "project_not_registered",
            detail: "Register this identity explicitly before moving it.",
          });
        const held = hasOpenSource(db, repository);
        if (held)
          return Err({
            reason: "project_source_open",
            detail: "End every open source before moving this project.",
          });
        if (openCleanup(db, repository)) return Err(cleanupOpen);
        if (openReview(db, repository)) return Err(reviewOpen);
        db.update(projects).set({ checkout }).where(eq(projects.repository, repository)).run();
        return Ok({ reason: "project_moved", data: { ...project, checkout } });
      },
    ),
  );
}
