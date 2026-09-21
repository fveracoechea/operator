import { grantApproval, matchApproval, revokeApproval } from "./approvals.ts";
import { acknowledgeAttempt } from "./dispatch-acknowledge.ts";
import type { Overrides } from "./dispatch-context.ts";
import { dispatchAttempt } from "./dispatch-launch.ts";
import { reconcileAttempt } from "./dispatch-reconcile.ts";
import { replaceAttempt } from "./dispatch-replace.ts";
import { showAttempt } from "./dispatch-report.ts";
import { readCapacity } from "./capacity.ts";
import { acceptAssignment, claimAssignment } from "./claims.ts";
import { calculateFrontier } from "./frontier.ts";
import { parseInput } from "./input.ts";
import { mutate, readState } from "./operations.ts";
import { claimOwnership, currentOwnership } from "./ownership.ts";
import { answerQuestion, reapplyAnswer } from "./question-answer.ts";
import { acknowledgeAnswer, deliverAnswer } from "./question-deliver.ts";
import { approvalCheckSchema, approvalInputSchema } from "./question-input.ts";
import { raiseQuestion, reviseQuestion } from "./question-raise.ts";
import { showQuestion } from "./question-report.ts";
import { registerWork } from "./registration.ts";
import { STATE_VERSION } from "./schema.ts";
import { workInputSchema } from "./work-input.ts";

type Located = { projectRoot: string };
type Mutation = Located & { requestId: string; ownerToken: string };

/** Every action answers in one shape, so a caller handles them alike. */
function reported<Result extends { status: string }>(
  result: Result,
): { repeated: boolean; result: Result } {
  return { repeated: "repeated" in result && result.repeated === true, result };
}

/** Only the named final status commits; every other status leaves the state unchanged. */
function commitOn<Outcome extends { status: string }>(
  outcome: Outcome,
  accepted: Outcome["status"],
): { commit: boolean; outcome: Outcome } {
  return { commit: outcome.status === accepted, outcome };
}

export const CrewState = {
  /**
   * Takes durable crew ownership, creating the crew state when this crew has none.
   * A takeover replaces the active token, so every later mutation under the old token fails.
   */
  async own(
    request: Located & {
      requestId: string;
      ownerLabel: string;
      takeover: boolean;
      ownershipRevision: number | null;
    },
  ) {
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: null,
        now: new Date().toISOString(),
        operation: "crew_own",
        input: {
          ownerLabel: request.ownerLabel,
          takeover: request.takeover,
          ownershipRevision: request.ownershipRevision,
        },
        create: true,
      },
      ({ tx, now }) =>
        commitOn(
          claimOwnership(tx, {
            ownerLabel: request.ownerLabel,
            takeover: request.takeover,
            ownershipRevision: request.ownershipRevision,
            token: crypto.randomUUID(),
            now,
          }),
          "acquired",
        ),
    );
  },

  /**
   * Registers approved work from one source, preserving its revision, scope, acceptance
   * requirements, permissions, fixed inputs, dependencies, and planning boundary.
   */
  async register(request: Mutation & { input: unknown }) {
    const parsed = parseInput(workInputSchema, request.input);
    if (parsed.status !== "parsed") {
      return reported(parsed);
    }

    const input = parsed.value;
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_register",
        input,
      },
      ({ tx, now }) => commitOn(registerWork(tx, { input, now }), "registered"),
    );
  },

  /** Claims one dispatchable assignment. Exactly one concurrent claim wins. */
  async claim(request: Mutation & { assignmentId: string; revision: number }) {
    const capacity = await readCapacity(request.projectRoot);
    if (capacity.status !== "ok") {
      return { repeated: false, result: capacity };
    }

    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_claim",
        input: { assignmentId: request.assignmentId, revision: request.revision },
      },
      ({ tx, now }) =>
        commitOn(
          claimAssignment(tx, {
            assignmentId: request.assignmentId,
            revision: request.revision,
            ownerToken: request.ownerToken,
            attemptId: crypto.randomUUID(),
            capacity: capacity.capacity,
            now,
          }),
          "claimed",
        ),
    );
  },

  /** Records accepted completion, which is the only result that unblocks a dependent. */
  async accept(
    request: Mutation & { assignmentId: string; attemptId: string | null; revision: number },
  ) {
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_accept",
        input: {
          assignmentId: request.assignmentId,
          attemptId: request.attemptId,
          revision: request.revision,
        },
      },
      ({ tx, now }) =>
        commitOn(
          acceptAssignment(tx, {
            assignmentId: request.assignmentId,
            attemptId: request.attemptId,
            revision: request.revision,
            now,
          }),
          "accepted",
        ),
    );
  },

  /**
   * Dispatches one claimed assignment to an isolated Operative worktree.
   * Every stage records its intent before it acts, so an interrupted launch is reconciled
   * against Herdr rather than repeated into a second writer.
   */
  async dispatch(
    request: Mutation & {
      attemptId: string;
      baseCommit: string | null;
      branch: string | null;
      worktreePath: string | null;
      overrides: Overrides;
    },
  ) {
    return dispatchAttempt(request);
  },

  /** Records the Operative's own acknowledgement, which is the proof that the brief arrived. */
  async acknowledge(
    request: Located & { requestId: string; attemptId: string; worktreePath: string },
  ) {
    return acknowledgeAttempt(request);
  },

  /** Settles every unfinished external effect of one attempt from what Herdr actually shows. */
  async reconcile(request: Mutation & { attemptId: string }) {
    return reconcileAttempt(request);
  },

  /** Starts a new attempt on the same assignment once the former writer is proven stopped. */
  async replace(request: Mutation & { attemptId: string; approvedInspection: string | null }) {
    return replaceAttempt(request);
  },

  /** Reports the recorded launch of one attempt and the state of its effects. Writes nothing. */
  async attempt(request: Located & { attemptId: string }) {
    return showAttempt(request);
  },

  /**
   * Records one blocked report from an Operative.
   * The report carries evidence, options, a recommendation, the scope that waits, and the work
   * that continues without the answer. It holds only the assignment that raised it.
   */
  async raiseQuestion(request: Located & { requestId: string; attemptId: string; input: unknown }) {
    return reported(await raiseQuestion({ ...request, questionId: crypto.randomUUID() }));
  },

  /** Records a changed question, which makes the answer given to the earlier one inapplicable. */
  async reviseQuestion(
    request: Located & {
      requestId: string;
      attemptId: string;
      questionId: string;
      revision: number;
      input: unknown;
    },
  ) {
    return reported(await reviseQuestion(request));
  },

  /**
   * Records the authoritative answer to one question revision.
   * A question that names a subject only a person may settle refuses an Operator decision.
   */
  async answerQuestion(
    request: Mutation & { questionId: string; revision: number; input: unknown },
  ) {
    return reported(await answerQuestion({ ...request, answerId: crypto.randomUUID() }));
  },

  /** Uses an earlier answer for a changed question, under an approval that names both. */
  async reapplyAnswer(
    request: Mutation & {
      questionId: string;
      revision: number;
      reuseAnswerId: string;
      approvalId: string;
    },
  ) {
    return reported(await reapplyAnswer({ ...request, answerId: crypto.randomUUID() }));
  },

  /** Carries one recorded answer to the Operative that asked. Recording it is a separate step. */
  async deliverAnswer(request: Mutation & { questionId: string }) {
    return reported(await deliverAnswer(request));
  },

  /** Records the Operative's own receipt of one answer, which releases the work that waited. */
  async acknowledgeAnswer(
    request: Located & { requestId: string; questionId: string; worktreePath: string },
  ) {
    return reported(await acknowledgeAnswer(request));
  },

  /** Reports one question and every answer it has held. Writes nothing. */
  async question(request: Located & { questionId: string }) {
    return reported(await showQuestion(request));
  },

  /**
   * Grants one approval for one exact action.
   * A person is the only source of authority here, so silence, a timeout, a general direction
   * to finish, and an Operative report all produce nothing.
   */
  async grantApproval(request: Mutation & { input: unknown }) {
    const parsed = parseInput(approvalInputSchema, request.input);
    if (parsed.status !== "parsed") {
      return reported(parsed);
    }

    const input = parsed.value;
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "approval_grant",
        input,
      },
      ({ tx, now }) =>
        commitOn(grantApproval(tx, { approvalId: crypto.randomUUID(), input, now }), "granted"),
    );
  },

  /** Ends one approval. A revoked approval covers nothing from that moment. */
  async revokeApproval(request: Mutation & { approvalId: string; revision: number }) {
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "approval_revoke",
        input: { approvalId: request.approvalId, revision: request.revision },
      },
      ({ tx, now }) =>
        commitOn(
          revokeApproval(tx, {
            approvalId: request.approvalId,
            revision: request.revision,
            now,
          }),
          "revoked",
        ),
    );
  },

  /** Reports whether a recorded approval covers one exact action right now. Writes nothing. */
  async checkApproval(request: Located & { input: unknown }) {
    const parsed = parseInput(approvalCheckSchema, request.input);
    if (parsed.status !== "parsed") {
      return reported(parsed);
    }

    const check = parsed.value;
    return reported(await readState(request.projectRoot, (db) => matchApproval(db, check)));
  },

  /** Reports the work a crew of this size may start now, and why the rest waits. Writes nothing. */
  async frontier(request: Located) {
    const capacity = await readCapacity(request.projectRoot);
    if (capacity.status !== "ok") {
      return { repeated: false, result: capacity };
    }

    const result = await readState(request.projectRoot, (db) => {
      const ownership = currentOwnership(db);
      return {
        status: "reported" as const,
        stateVersion: STATE_VERSION,
        // The owner token stays out of a read anyone may run; only its identity is reported.
        ownership:
          ownership === null
            ? null
            : {
                ownerLabel: ownership.ownerLabel,
                acquiredAt: ownership.acquiredAt,
                revision: ownership.revision,
              },
        ...calculateFrontier(db, capacity.capacity),
      };
    });

    // Every action on this interface answers in one shape, so a caller handles them alike.
    return { repeated: false, result };
  },
};
