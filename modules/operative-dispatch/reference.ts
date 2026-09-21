import { REFERENCE_PATH } from "./plan.ts";

export type AttemptReference = {
  controllingCheckout: string;
  assignmentId: string;
  attemptId: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
};

function readString(source: object, key: string): string | null {
  const value = Reflect.get(source, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function complete(
  reference: Record<keyof AttemptReference, string | null>,
): reference is AttemptReference {
  return Object.values(reference).every((value) => value !== null);
}

/** Reads one worktree's control reference. A reference that is not complete is not a reference. */
export async function readReference(worktreePath: string): Promise<AttemptReference | null> {
  const file = Bun.file(`${worktreePath}/${REFERENCE_PATH}`);
  if (!(await file.exists())) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") {
    return null;
  }

  const reference = {
    controllingCheckout: readString(parsed, "controllingCheckout"),
    assignmentId: readString(parsed, "assignmentId"),
    attemptId: readString(parsed, "attemptId"),
    branch: readString(parsed, "branch"),
    baseCommit: readString(parsed, "baseCommit"),
    worktreePath: readString(parsed, "worktreePath"),
  };

  return complete(reference) ? reference : null;
}
