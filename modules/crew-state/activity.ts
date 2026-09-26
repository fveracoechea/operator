import { Database } from "bun:sqlite";
import { STATE_PATH } from "./database.ts";

export type ActiveWork = {
  assignmentId: string;
  state: string;
  attemptId: string | null;
  attemptState: string | null;
};

export type Activity =
  | { status: "missing"; path: string }
  | { status: "unreadable"; path: string; detail: string }
  | { status: "read"; path: string; stateVersion: number; active: ActiveWork[] };

// An assignment resting in one of these states owes the crew nothing right now.
const SETTLED_ASSIGNMENT_STATES = ["registered", "accepted", "invalidated"];

type ActiveRow = {
  assignment_id: string;
  state: string;
  attempt_id: string | null;
  attempt_state: string | null;
};

/**
 * Reads what this crew still has in flight, from the file exactly as it stands.
 * The read opens the state file directly, because an update must answer this question about a
 * file written by an earlier release, which every other command refuses to open.
 */
export function readActivity(projectRoot: string): Activity {
  const path = `${projectRoot}/${STATE_PATH}`;
  let sqlite: Database;
  try {
    sqlite = new Database(path, { create: false, readonly: true });
  } catch (error) {
    return Bun.file(path).size === 0
      ? { status: "missing", path }
      : { status: "unreadable", path, detail: String(error) };
  }

  try {
    const meta = sqlite.query("select state_version from state_meta where id = 1").get();
    const stateVersion =
      meta !== null && typeof meta === "object" && "state_version" in meta
        ? Number(meta.state_version)
        : Number.NaN;
    if (!Number.isFinite(stateVersion)) {
      return { status: "unreadable", path, detail: "The state file records no state version." };
    }

    const settled = [...SETTLED_ASSIGNMENT_STATES].map((state) => `'${state}'`).join(", ");
    const rows = sqlite
      .query<ActiveRow, []>(
        `select a.id as assignment_id, a.state as state, t.id as attempt_id, t.state as attempt_state
         from assignments a
         left join attempts t on t.assignment_id = a.id and t.state = 'active'
         where a.state not in (${settled}) or t.id is not null`,
      )
      .all();

    return {
      status: "read",
      path,
      stateVersion,
      active: rows.map((row) => ({
        assignmentId: row.assignment_id,
        state: row.state,
        attemptId: row.attempt_id,
        attemptState: row.attempt_state,
      })),
    };
  } catch (error) {
    return { status: "unreadable", path, detail: String(error) };
  } finally {
    sqlite.close();
  }
}
