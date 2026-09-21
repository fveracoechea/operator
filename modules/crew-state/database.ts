import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
// Bun has no filesystem link or recursive removal API.
import { link, rm } from "node:fs/promises";
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

  if (stateVersion > STATE_VERSION) {
    opened.sqlite.close();
    return { status: "unsupported", path, found: stateVersion, supported: STATE_VERSION };
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
export async function createState(
  projectRoot: string,
  now: string,
): Promise<OpenResult | { status: "exists" }> {
  const path = statePath(projectRoot);
  if (await Bun.file(path).exists()) {
    return { status: "exists" };
  }

  const directory = dirname(path);
  await Bun.$`mkdir -p ${directory}`.quiet();
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;

  try {
    const building = connect(temporaryPath, { create: true, walMode: false });
    try {
      building.db.transaction((tx) => {
        for (const statement of CREATE_STATEMENTS) {
          tx.run(statement);
        }
        tx.insert(crewStateSchema.stateMeta)
          .values({ id: 1, stateVersion: STATE_VERSION, createdAt: now })
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
