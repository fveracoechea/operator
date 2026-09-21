import { OperatorConfig } from "../operator-config/main.ts";
import { readWriterContext, type WriterFailure } from "./dispatch-context.ts";
import { identityOf } from "./identity.ts";
import { mutate, readState } from "./operations.ts";
import { submissionInputSchema } from "./submission-input.ts";
import { submissionOfAttempt, type SubmitOutcome, submitResult } from "./submission.ts";
import { storeArtifacts, type StoreOutcome } from "./submission-store.ts";

type StoreFailure = Exclude<StoreOutcome, { status: "stored" }>;

export type SubmitResult =
  | SubmitOutcome
  | { status: "invalid-input"; issues: string[] }
  | StoreFailure
  | WriterFailure;

type Reported = { repeated: boolean; result: SubmitResult };

/**
 * Records one fixed result as a durable handoff to review.
 * The Operative runs it from its own worktree, so it carries no ownership token and the
 * attempt it names must still be the current writer.
 */
export async function submitAttemptResult(request: {
  projectRoot: string;
  requestId: string;
  attemptId: string;
  worktreePath: string;
  input: unknown;
}): Promise<Reported> {
  const parsed = submissionInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      repeated: false,
      result: {
        status: "invalid-input",
        issues: parsed.error.issues.map(OperatorConfig.describeIssue),
      },
    };
  }

  // A submission ends its attempt, so a repeat reports the recorded submission of that attempt
  // instead of the ended attempt that no longer reads as the current writer.
  const held = await readState(request.projectRoot, (db) =>
    submissionOfAttempt(db, request.attemptId),
  );
  if (held !== null && "status" in held) {
    return { repeated: false, result: held };
  }
  if (held !== null) {
    return {
      repeated: true,
      result: { status: "already-submitted", attemptId: request.attemptId, submissionId: held.id },
    };
  }

  const read = await readWriterContext(request.projectRoot, request);
  if (read.status !== "ok") {
    return { repeated: false, result: read };
  }
  const dispatch = read.dispatch;

  const input = parsed.data;
  const submissionId = identityOf({ attemptId: request.attemptId, input }).slice(0, 32);
  const stored = await storeArtifacts({
    projectRoot: request.projectRoot,
    worktreePath: dispatch.worktreePath,
    submissionId,
    artifacts: input.artifacts,
  });
  if (stored.status !== "stored") {
    return { repeated: false, result: stored };
  }

  const { repeated, result } = await mutate<SubmitOutcome>(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: null,
      now: new Date().toISOString(),
      operation: "attempt_submit",
      input: { attemptId: request.attemptId, submission: input },
    },
    ({ tx, now }) => {
      const outcome = submitResult(tx, {
        attempt: read.context.attempt,
        assignment: read.context.assignment,
        input,
        artifacts: stored.artifacts,
        submissionId,
        reviewId: crypto.randomUUID(),
        now,
      });
      return { commit: outcome.status === "submitted", outcome };
    },
  );

  return { repeated, result };
}
