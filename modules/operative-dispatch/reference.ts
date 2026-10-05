import { z } from "zod";
import { REFERENCE_PATH } from "./plan.ts";

const referenceSchema = z.object({
  controllingCheckout: z.string().min(1),
  assignmentId: z.string().min(1),
  attemptId: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().min(1),
  worktreePath: z.string().min(1),
});

export type AttemptReference = z.infer<typeof referenceSchema>;

// Anything unusable at the path is malformed, not missing: the Operative runs in the right place.
export type ReferenceInspection =
  | { status: "read"; reference: AttemptReference }
  | { status: "missing" }
  | {
      status: "malformed";
      problem: "unreadable" | "not-json" | "not-object" | "incomplete";
      fields: string[];
    };

/** Inspects one worktree's control reference, and names what makes it unusable. */
export async function inspectReference(worktreePath: string): Promise<ReferenceInspection> {
  let text: string;
  try {
    text = await Bun.file(`${worktreePath}/${REFERENCE_PATH}`).text();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { status: "missing" }
      : { status: "malformed", problem: "unreadable", fields: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "malformed", problem: "not-json", fields: [] };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed", problem: "not-object", fields: [] };
  }

  const read = referenceSchema.safeParse(parsed);
  if (!read.success) {
    const fields = new Set(read.error.issues.map((issue) => String(issue.path[0])));
    return { status: "malformed", problem: "incomplete", fields: [...fields] };
  }

  return { status: "read", reference: read.data };
}
