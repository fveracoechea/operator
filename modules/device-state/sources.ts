import { and, asc, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { Err, Ok, type Result } from "unthrown";
import { checkHistory, transaction } from "./database.ts";
import { assignments, projects, sources } from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type SourceRow = typeof sources.$inferSelect;
export type AssignmentRow = typeof assignments.$inferSelect;
export type SourceFailure =
  | StateFailure
  | { reason: "source_parent_open" | "source_not_found"; detail: string };

export function registerSource(
  client: Database,
  checkout: string,
  source: SourceRow,
  rows: AssignmentRow[],
) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<SourceRow, SourceFailure> => {
      const controller = db
        .select()
        .from(projects)
        .where(eq(projects.repository, source.repository))
        .get();
      if (controller?.checkout !== checkout)
        return Err({
          reason: "controller_mismatch",
          detail: "The controlling checkout changed before registration. Read the project again.",
        });
      const existing = db
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.repository, source.repository),
            eq(sources.trackerKey, source.trackerKey),
            eq(sources.state, "open"),
          ),
        )
        .get();
      if (existing)
        return Err({
          reason: "source_parent_open",
          detail: `Source ${existing.id} is still open for ${source.trackerKey}.`,
        });
      db.insert(sources).values(source).run();
      if (rows.length > 0) db.insert(assignments).values(rows).run();
      return Ok(source);
    }),
  );
}

export function readSources(client: Database, repository: string, sourceId?: string) {
  return transaction(client, false, () =>
    checkHistory(client).flatMap(
      (db): Result<{ source: SourceRow; assignments: AssignmentRow[] }[], SourceFailure> => {
        const rows = db
          .select()
          .from(sources)
          .where(
            sourceId === undefined
              ? eq(sources.repository, repository)
              : and(eq(sources.repository, repository), eq(sources.id, sourceId)),
          )
          .orderBy(asc(sources.registeredAt), asc(sources.id))
          .all();
        if (sourceId !== undefined && rows.length === 0)
          return Err({
            reason: "source_not_found",
            detail: "The source does not exist in this project.",
          });
        return Ok(
          rows.map((source) => ({
            source,
            assignments: db
              .select()
              .from(assignments)
              .where(eq(assignments.sourceId, source.id))
              .all(),
          })),
        );
      },
    ),
  );
}
