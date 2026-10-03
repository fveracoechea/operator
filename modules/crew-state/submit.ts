import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import { readWriterContext, type WriterFailure } from "./dispatch-context.ts";
import { identityOf } from "./identity.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import { gateOfAttempt } from "./integration.ts";
import { type IntegrationInputsRead, storeIntegrationInputs } from "./integration-inputs.ts";
import { mutate, readState } from "./operations.ts";
import { outsideChangesOf } from "./outside-changes.ts";
import { answerAuthoritiesOf } from "./questions.ts";
import { refuseResult, type ResultRefusal } from "./result-checks.ts";
import { submissionInputSchema } from "./submission-input.ts";
import { submissionOfAttempt, type SubmitOutcome, submitResult } from "./submission.ts";
import { storeArtifacts, storeSpec, type StoreOutcome } from "./submission-store.ts";
import { storedRequirements } from "./work-input.ts";

type StoreFailure = Exclude<StoreOutcome, { status: "stored" }>;

// A refused result records nothing, so its attempt keeps running and its Operative makes the fix.
type ResultRefused = {
  status: "result-refused";
  attemptId: string;
  refusals: [ResultRefusal, ...ResultRefusal[]];
};

export type SubmitResult =
  | SubmitOutcome
  | Extract<IntegrationInputsRead, { status: "integration-branch-unread" }>
  | InvalidInput
  | StoreFailure
  | WriterFailure
  | ResultRefused;

type Reported = { repeated: boolean; result: SubmitResult };

/**
 * Records one fixed result as a durable handoff to review.
 * The Operative runs it from its own worktree, so it carries no ownership token and the
 * attempt it names must still be the current writer. The result is read from Git and checked
 * against its authority limits first (ADR 0018), never taken from what the Operative states.
 */
export async function submitAttemptResult(request: {
  projectRoot: string;
  requestId: string;
  attemptId: string;
  worktreePath: string;
  input: unknown;
}): Promise<Reported> {
  const parsed = parseInput(submissionInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return { repeated: false, result: parsed };
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

  const input = parsed.value;
  let outside: ReturnType<typeof outsideChangesOf> = [];
  // The gate is the one fixed on the source, or the one at the commit the attempt started from
  // before the source fixed one. It is never read from a working tree.
  const gate = await gateOfAttempt({
    projectRoot: request.projectRoot,
    sourceId: read.context.assignment.sourceId,
    baseCommit: dispatch.baseCommit,
  });
  // Only production work submits a result, and the transaction below refuses any other kind.
  if (read.context.assignment.kind === "production") {
    const assignment = read.context.assignment;
    const questions = await readState(request.projectRoot, (db) =>
      answerAuthoritiesOf(db, assignment.id),
    );
    if (!(questions instanceof Map)) {
      return { repeated: false, result: questions };
    }
    const refusals = refuseResult({
      inspection: await OperativeDispatch.inspectCheckout({
        worktreePath: dispatch.worktreePath,
        baseCommit: dispatch.baseCommit,
        agentHost: dispatch.agentHost,
      }),
      input,
      baseCommit: dispatch.baseCommit,
      writePaths: read.context.writePaths,
      bases: {
        requirementCount: storedRequirements(assignment.acceptanceRequirements).length,
        questions,
      },
      gate,
    });
    const [first, ...rest] = refusals;
    if (first !== undefined) {
      return {
        repeated: false,
        result: {
          status: "result-refused",
          attemptId: request.attemptId,
          refusals: [first, ...rest],
        },
      };
    }

    // The "after" scan runs only on a result that passed every check, and it never refuses one,
    // because the scan cannot name the writer of what it finds (ADR 0018).
    outside = outsideChangesOf({
      before: dispatch.outsideScan,
      after: await OperativeDispatch.scanOutside({
        projectRoot: request.projectRoot,
        worktreePath: dispatch.worktreePath,
      }),
      worktreePath: dispatch.worktreePath,
      projectRoot: request.projectRoot,
    });
  }

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

  const spec = await storeSpec({
    projectRoot: request.projectRoot,
    submissionId,
    assignment: read.context.assignment,
    // The producer brief carried the records its launch fixed. A launch recorded before that
    // list existed carried the latest records.
    planningRecords: read.context.planning.launched ?? read.context.planning.latest,
  });

  // A combined revision of an integration cycle is reviewed with the patch that was reviewed and
  // the interdiff to it, both fixed before the transaction, as the spec is.
  const integration = await storeIntegrationInputs({
    projectRoot: request.projectRoot,
    attemptId: request.attemptId,
    assignmentId: read.context.assignment.id,
    sourceId: read.context.assignment.sourceId,
    submissionId,
    commit: input.code?.resultCommit ?? null,
  });
  if (integration.status !== "none" && integration.status !== "stored") {
    return { repeated: false, result: integration };
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
        spec,
        integration: integration.status === "stored" ? integration.inputs : null,
        outside,
        // A reviewer may run the project gate, and no reviewer outcome stands in for a gate run.
        gateCommands:
          gate.status === "declared"
            ? gate.commands.map((one) => ProjectGate.commandLine(one.argv))
            : [],
        submissionId,
        reviewId: crypto.randomUUID(),
        now,
      });
      return { commit: outcome.status === "submitted", outcome };
    },
  );

  return { repeated, result };
}
