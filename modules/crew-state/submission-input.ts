import { z } from "zod";

/**
 * An artifact is fixed by its content identity, never by its path alone.
 * A path artifact is copied into a durable store at submission, so a later change to the
 * Operative worktree cannot change what the review reads.
 */
const artifact = z
  .strictObject({
    name: z.string().min(1),
    kind: z.enum(["value", "path"]),
    value: z.string().min(1),
    contentIdentity: z.string().min(1).nullable(),
  })
  .refine((input) => input.kind === "value" || input.contentIdentity !== null, {
    error: "a path artifact requires its content identity",
    path: ["contentIdentity"],
  });

/** A check states its command and what that command actually did, including a flaky run. */
const check = z.strictObject({
  name: z.string().min(1),
  command: z.string().min(1),
  outcome: z.enum(["passed", "failed", "flaky", "not-run"]),
  detail: z.string(),
});

const decision = z.strictObject({
  statement: z.string().min(1),
  authority: z.enum(["requirement", "human-answer", "operator-decision"]),
  reason: z.string().min(1),
});

/**
 * A pull request with no authority to create it is recorded as missing, never as absent.
 * Acceptance then reports the approval blocker instead of treating silence as a pass.
 */
const pullRequest = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("open"),
    number: z.int().positive(),
    headCommit: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("authority-missing"),
    detail: z.string().min(1),
  }),
]);

const codeRevisions = z.strictObject({
  baseCommit: z.string().min(1),
  resultCommit: z.string().min(1),
  mergeBase: z.string().min(1),
  branch: z.string().min(1),
  pullRequest,
});

const fixedFields = {
  assignmentRevision: z.int().positive(),
  sourceRevision: z.string().min(1),
  requirementsIdentity: z.string().min(1),
  artifacts: z.array(artifact).min(1),
  concerns: z.array(z.string().min(1)),
  decisions: z.array(decision),
};

export const submissionInputSchema = z.discriminatedUnion("resultKind", [
  z.strictObject({
    ...fixedFields,
    resultKind: z.literal("code"),
    // A code result names the commands it ran, because acceptance reads every one of them.
    checks: z.array(check).min(1),
    code: codeRevisions,
  }),
  z.strictObject({
    ...fixedFields,
    resultKind: z.literal("non-code"),
    checks: z.array(check),
    // A non-code result may still carry code revisions, and is not required to.
    code: codeRevisions.nullable(),
  }),
]);

export type SubmissionInput = z.infer<typeof submissionInputSchema>;
export type SubmittedArtifact = SubmissionInput["artifacts"][number];
export type SubmittedCheck = z.infer<typeof check>;
export type SubmittedCode = z.infer<typeof codeRevisions>;

/** One predicate owns what a recorded result kind means, so no reader decides it again. */
export function isCodeResult(resultKind: string): boolean {
  return resultKind === "code";
}

/** The tokens each axis report must state for this result kind, so coverage is checkable. */
export function requiredCoverage(resultKind: string): string[] {
  return isCodeResult(resultKind)
    ? ["diff", "requirements", "checks"]
    : ["artifacts", "requirements", "citations", "provenance"];
}
