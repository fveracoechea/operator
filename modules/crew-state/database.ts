import { Database } from "bun:sqlite";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
// Bun has no filesystem link, directory creation, or recursive removal API.
import { link, mkdir, rm } from "node:fs/promises";
// Bun has no path manipulation API.
import { dirname } from "node:path";
import { CREATE_STATEMENTS, crewStateSchema, STATE_VERSION } from "./schema.ts";

export const STATE_PATH = ".operator/local/crew-state.sqlite";

export type CrewDatabase = ReturnType<typeof connect>["db"];

/** The handle inside a write transaction. Every mutation takes this, never the bare database. */
export type CrewWriter = Parameters<Parameters<CrewDatabase["transaction"]>[0]>[0];

/** The read surface both a database and a transaction satisfy. */
export type CrewReader = Pick<CrewDatabase, "select">;

export type OpenResult =
  | { status: "open"; db: CrewDatabase; close: () => void; stateVersion: number }
  | { status: "missing"; path: string }
  | { status: "unreadable"; path: string; detail: string }
  | { status: "outdated"; path: string; found: number; supported: number }
  | { status: "unsupported"; path: string; found: number; supported: number };

function statePath(projectRoot: string): string {
  return `${projectRoot}/${STATE_PATH}`;
}

function connect(path: string, options: { create: boolean; walMode: boolean }) {
  const sqlite = new Database(path, { create: options.create, readwrite: true });
  // WAL plus a wait lets a second Operator process block on a write instead of failing at once.
  // A file still being built stays on the rollback journal, so it is complete in one file.
  sqlite.exec(`pragma journal_mode = ${options.walMode ? "wal" : "delete"}`);
  sqlite.exec("pragma busy_timeout = 10000");
  sqlite.exec("pragma foreign_keys = on");
  return { sqlite, db: drizzle({ client: sqlite, schema: crewStateSchema }) };
}

/** Opens existing crew state. A missing, damaged, or newer file is reported, never replaced. */
export async function openState(projectRoot: string): Promise<OpenResult> {
  const path = statePath(projectRoot);
  if (!(await Bun.file(path).exists())) {
    return { status: "missing", path };
  }

  let opened: ReturnType<typeof connect>;
  try {
    opened = connect(path, { create: false, walMode: true });
  } catch (error) {
    return { status: "unreadable", path, detail: String(error) };
  }

  let found: unknown;
  try {
    found = opened.sqlite.query("select state_version from state_meta where id = 1").get();
  } catch (error) {
    opened.sqlite.close();
    return { status: "unreadable", path, detail: String(error) };
  }

  const stateVersion =
    found !== null && typeof found === "object" && "state_version" in found
      ? found.state_version
      : null;

  if (typeof stateVersion !== "number") {
    opened.sqlite.close();
    return { status: "unreadable", path, detail: "The state file records no state version." };
  }

  // A file that predates a table this release reads is reported, never repaired in silence.
  let tables: unknown[];
  try {
    tables = opened.sqlite.query("select name from sqlite_master where type = 'table'").all();
  } catch (error) {
    opened.sqlite.close();
    return { status: "unreadable", path, detail: String(error) };
  }

  const present = new Set(
    tables.flatMap((row) =>
      row !== null && typeof row === "object" && "name" in row && typeof row.name === "string"
        ? [row.name]
        : [],
    ),
  );
  const missing = Object.values(crewStateSchema)
    .map((table) => getTableName(table))
    .filter((name) => !present.has(name));
  if (missing.length > 0) {
    opened.sqlite.close();
    return {
      status: "unreadable",
      path,
      detail: `The state file is missing the ${missing.toSorted().join(", ")} table(s).`,
    };
  }

  if (stateVersion > STATE_VERSION) {
    opened.sqlite.close();
    return { status: "unsupported", path, found: stateVersion, supported: STATE_VERSION };
  }

  // An older file is left exactly as it is. Only an approved update migrates it, so a command
  // that happened to run first never rewrites a format the user has not backed up.
  if (stateVersion < STATE_VERSION) {
    opened.sqlite.close();
    return { status: "outdated", path, found: stateVersion, supported: STATE_VERSION };
  }

  return {
    status: "open",
    db: opened.db,
    close: () => opened.sqlite.close(),
    stateVersion,
  };
}

/**
 * Creates crew state for a crew that has none. The tables are built in a temporary file and
 * linked into place, so a failed creation leaves nothing and two Operator processes racing to
 * start the same crew cannot produce a half-built or replaced state file.
 */
/** Opens the state file directly, for the one operation that changes its recorded format. */
export function openForMigration(projectRoot: string) {
  const path = statePath(projectRoot);
  const sqlite = new Database(path, { create: false, readwrite: true });
  sqlite.exec("pragma busy_timeout = 10000");
  return sqlite;
}

export async function createState(
  projectRoot: string,
  now: string,
): Promise<OpenResult | { status: "exists" }> {
  const path = statePath(projectRoot);
  if (await Bun.file(path).exists()) {
    return { status: "exists" };
  }

  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;

  try {
    const building = connect(temporaryPath, { create: true, walMode: false });
    try {
      building.db.transaction((tx) => {
        for (const statement of CREATE_STATEMENTS) {
          tx.run(statement);
        }
        tx.insert(crewStateSchema.stateMeta)
          .values({ id: 1, stateVersion: STATE_VERSION, createdAt: now, releaseIdentity: null })
          .run();
      });
    } finally {
      building.sqlite.close();
    }

    try {
      // link fails when the target exists, so the first writer wins and nothing is replaced.
      await link(temporaryPath, path);
    } catch {
      return { status: "exists" };
    }
  } catch (error) {
    return { status: "unreadable", path, detail: String(error) };
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return openState(projectRoot);
}
