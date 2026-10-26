import { eq, inArray, or } from "drizzle-orm";
import { Err, Ok, type Result } from "unthrown";
import type { Database } from "bun:sqlite";
import { checkHistory, transaction } from "./database.ts";
import { projects } from "./schema.ts";
import type { StateFailure } from "./failures.ts";

export type RegisteredProject = typeof projects.$inferSelect;
export type Registration = {
  reason: "project_registered" | "project_unchanged";
  data: RegisteredProject;
};

export function registerProject(client: Database, project: RegisteredProject) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<Registration, StateFailure> => {
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
      const byIdentity = existing.find((row) => row.repository === project.repository);
      if (byIdentity && byIdentity.checkout !== project.checkout)
        return Err<StateFailure>({
          reason: "controller_mismatch",
          detail: `Use the recorded controlling checkout at ${byIdentity.checkout}. If it is missing, an explicit project move is required when that operation is available.`,
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
