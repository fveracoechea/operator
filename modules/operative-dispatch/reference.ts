import { REFERENCE_PATH } from "./plan.ts";

export type AttemptReference = {
  controllingCheckout: string;
  assignmentId: string;
  attemptId: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
};

/**
 * What one worktree carries at its control reference path.
 * A file that is there but cannot be read as a complete reference is malformed, not missing,
 * so a command can tell an Operative that runs elsewhere from a reference that was changed.
 */
export type ReferenceInspection =
  | { status: "read"; reference: AttemptReference }
  | { status: "missing" }
  | { status: "malformed"; problem: "not-json" | "not-object" | "incomplete"; fields: string[] };

const FIELDS = [
  "controllingCheckout",
  "assignmentId",
  "attemptId",
  "branch",
  "baseCommit",
  "worktreePath",
] as const satisfies ReadonlyArray<keyof AttemptReference>;

function readString(source: object, key: string): string | null {
  const value = Reflect.get(source, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function complete(
  reference: Record<keyof AttemptReference, string | null>,
): reference is AttemptReference {
  return Object.values(reference).every((value) => value !== null);
}

/** Inspects one worktree's control reference, and names what makes it unusable. */
export async function inspectReference(worktreePath: string): Promise<ReferenceInspection> {
  const file = Bun.file(`${worktreePath}/${REFERENCE_PATH}`);
  if (!(await file.exists())) {
    return { status: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { status: "malformed", problem: "not-json", fields: [] };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed", problem: "not-object", fields: [] };
  }

  const reference = {
    controllingCheckout: readString(parsed, "controllingCheckout"),
    assignmentId: readString(parsed, "assignmentId"),
    attemptId: readString(parsed, "attemptId"),
    branch: readString(parsed, "branch"),
    baseCommit: readString(parsed, "baseCommit"),
    worktreePath: readString(parsed, "worktreePath"),
  };
  if (!complete(reference)) {
    const absent = FIELDS.filter((field) => reference[field] === null);
    return { status: "malformed", problem: "incomplete", fields: absent };
  }

  return { status: "read", reference };
}

/** Reads one worktree's control reference. A reference that is not complete is not a reference. */
export async function readReference(worktreePath: string): Promise<AttemptReference | null> {
  const inspected = await inspectReference(worktreePath);
  return inspected.status === "read" ? inspected.reference : null;
}
