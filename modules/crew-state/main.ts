import { grantApproval, matchApproval, revokeApproval } from "./approvals.ts";
import { closeProcess } from "./cleanup-close.ts";
import { holdInputSchema, placeHold, releaseHold } from "./cleanup-hold.ts";
import { removeWorktree } from "./cleanup-remove.ts";
import { showCleanups } from "./cleanup-report.ts";
import { acknowledgeAttempt } from "./dispatch-acknowledge.ts";
import { adoptAttempt } from "./dispatch-adopt.ts";
import type { Overrides } from "./dispatch-context.ts";
import { dispatchAttempt } from "./dispatch-launch.ts";
import { reconcileAttempt } from "./dispatch-reconcile.ts";
import { replaceAttempt } from "./dispatch-replace.ts";
import { showAttempt } from "./dispatch-report.ts";
import { readCapacity } from "./capacity.ts";
import { acceptAssignment } from "./acceptance.ts";
import { claimAssignment } from "./claims.ts";
import { calculateFrontier } from "./frontier.ts";
import { calculateNext, calculateUnowned, isStandingAction } from "./next.ts";
import { parseInput } from "./input.ts";
import { mutate, readState } from "./operations.ts";
import { claimOwnership, currentOwnership } from "./ownership.ts";
import { answerQuestion, escalateQuestion, reapplyAnswer } from "./question-answer.ts";
import { acknowledgeAnswer, deliverAnswer } from "./question-deliver.ts";
import { approvalCheckSchema, approvalInputSchema } from "./approval-input.ts";
import { raiseQuestion, reviseQuestion } from "./question-raise.ts";
import { showQuestion } from "./question-report.ts";
import { defectInputSchema, type InvalidateOutcome, invalidateResult } from "./invalidate.ts";
import { registerWork } from "./registration.ts";
import { openReworkCycle, type ReworkOutcome } from "./rework-open.ts";
import { reworkInputSchema } from "./rework-input.ts";
import { dispositionInputSchema } from "./review-input.ts";
import { disposeFindings, type DisposeOutcome } from "./review-dispose.ts";
import { recordReview } from "./review-record.ts";
import { showReview } from "./review-show.ts";
import { readReview } from "./review.ts";
import { submitAttemptResult } from "./submit.ts";
import { recordTrackerStep, recoverTrackerStep } from "./tracker-apply.ts";
import { readTrackerMap, showTrackerSteps } from "./tracker-show.ts";
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

  /**
   * Records accepted completion, which is the only result that unblocks a dependent.
   * Production work reaches it only through a reviewed submission, so every review gate is
   * checked here rather than on a second path to acceptance.
   */
  async accept(
    request: Mutation & {
      assignmentId: string;
      attemptId: string | null;
      revision: number;
      submissionId: string | null;
      prHead: string | null;
    },
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
          submissionId: request.submissionId,
          prHead: request.prHead,
        },
      },
      ({ tx, now }) =>
        commitOn(
          acceptAssignment(tx, {
            assignmentId: request.assignmentId,
            attemptId: request.attemptId,
            revision: request.revision,
            submissionId: request.submissionId,
            prHead: request.prHead,
            now,
          }),
          "accepted",
        ),
    );
  },

  /**
   * Records one fixed result as a durable handoff to a separate review.
   * The assignment moves to awaiting review and its attempt ends, so the crew slot it held
   * becomes free for the reviewer. A submission is never accepted completion.
   */
  async submit(
    request: Located & {
      requestId: string;
      attemptId: string;
      worktreePath: string;
      input: unknown;
    },
  ) {
    return submitAttemptResult(request);
  },

  /**
   * Records the two axis reports of one review, or the blocker that stopped it.
   * A review report ends the review chain, so it never becomes a submitted result of its own.
   */
  async report(
    request: Located & {
      requestId: string;
      reviewId: string;
      attemptId: string;
      worktreePath: string;
      input: unknown;
    },
  ) {
    return recordReview(request);
  },

  /** Records what the Operator decided about each finding, so no finding disappears. */
  async dispose(request: Mutation & { reviewId: string; input: unknown }) {
    const parsed = parseInput(dispositionInputSchema, request.input);
    if (parsed.status !== "parsed") {
      return reported(parsed);
    }

    const input = parsed.value;
    return mutate<DisposeOutcome | { status: "unknown-review"; reviewId: string }>(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "review_dispose",
        input: { reviewId: request.reviewId, dispositions: input.dispositions },
      },
      ({ tx, now }) => {
        const review = readReview(tx, request.reviewId);
        if (review === null) {
          return {
            commit: false,
            outcome: { status: "unknown-review" as const, reviewId: request.reviewId },
          };
        }

        return commitOn(disposeFindings(tx, { review, input, now }), "disposed");
      },
    );
  },

  /**
   * Records a defect found in an accepted result.
   * The acceptance and its evidence stay recorded, because that history is what names the
   * dependents that read the invalid result. Only the work that consumed it is paused.
   */
  async invalidate(request: Mutation & { assignmentId: string; revision: number; input: unknown }) {
    const parsed = parseInput(defectInputSchema, request.input);
    if (parsed.status !== "parsed") {
      return reported(parsed);
    }

    const input = parsed.value;
    return mutate<InvalidateOutcome>(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_invalidate",
        input: { assignmentId: request.assignmentId, revision: request.revision, defect: input },
      },
      ({ tx, now }) =>
        commitOn(
          invalidateResult(tx, {
            invalidationId: crypto.randomUUID(),
            assignmentId: request.assignmentId,
            revision: request.revision,
            input,
            now,
          }),
          "invalidated",
        ),
    );
  },

  /**
   * Delegates one rework cycle on one submitted result.
   * The cycle returns the assignment to the frontier, so the accepted corrections reach a fresh
   * Operative through the ordinary claim and dispatch path rather than the reviewer or this
   * Operator. A reached limit records the direction it needs from the user instead.
   */
  async rework(request: Mutation & { assignmentId: string; revision: number; input: unknown }) {
    const parsed = parseInput(reworkInputSchema, request.input);
    if (parsed.status !== "parsed") {
      return reported(parsed);
    }

    const input = parsed.value;
    return mutate<ReworkOutcome>(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "work_rework",
        input: { assignmentId: request.assignmentId, revision: request.revision, rework: input },
      },
      ({ tx, now }) => {
        const outcome = openReworkCycle(tx, {
          cycleId: crypto.randomUUID(),
          assignmentId: request.assignmentId,
          revision: request.revision,
          input,
          now,
        });
        // A reached limit records the direction request it raised, so the refusal is durable.
        return {
          commit: outcome.status === "delegated" || outcome.status === "limit-reached",
          outcome,
        };
      },
    );
  },

  /** Reports one review, its two axis reports, and every finding disposition. Writes nothing. */
  async review(request: Located & { reviewId: string }) {
    return { repeated: false, result: await showReview(request) };
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

  /**
   * Moves one live attempt to the Operator that owns the crew now.
   * A takeover blocks every attempt the replaced Operator claimed, and this is the step that
   * states the new owner read what each of them still holds.
   */
  async adopt(request: Mutation & { attemptId: string }) {
    return adoptAttempt(request);
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

  /**
   * Records the Operator's own finding that one question is outside delegated authority.
   * It drops an Operator decision recorded before it, and leaves a person's answer standing.
   */
  async escalateQuestion(
    request: Mutation & { questionId: string; revision: number; input: unknown },
  ) {
    return reported(await escalateQuestion(request));
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

  /**
   * Records one step of this assignment's tracker update: the resolution, the ticket
   * completion, or the map amendment. Each step holds its own intent, write attempts, evidence,
   * and outcome, so one verified step is never written again to repair another.
   * A step left uncertain by a lost answer accepts another write only under a person's approval.
   */
  async recordTracker(
    request: Mutation & {
      assignmentId: string;
      revision: number;
      approvalId: string | null;
      input: unknown;
    },
  ) {
    return reported(await recordTrackerStep(request));
  },

  /**
   * Settles one recorded tracker step from what the tracker shows now. It sends nothing.
   * An unsuccessful read leaves the step where it was, because it does not prove that a write
   * did not apply.
   */
  async recoverTracker(request: Mutation & { operationId: string }) {
    return reported(await recoverTrackerStep(request));
  },

  /** Reports every tracker step of one assignment and what may follow it. Writes nothing. */
  async trackerSteps(request: Located & { assignmentId: string }) {
    return reported(await showTrackerSteps(request));
  },

  /**
   * Reads the canonical map of one assignment's source: its baseline plus every amendment.
   * A session reads this before it selects map-dependent work. Writes nothing.
   */
  async trackerMap(request: Located & { assignmentId: string }) {
    return reported(await readTrackerMap(request));
  },

  /**
   * Closes one Operative process after a durable handoff.
   * It proves the handoff, the revisions, the evidence, the answered questions, the stopped
   * writing, the accounted child tools, and the termination itself. The checkout is untouched,
   * because disposal is a separate outcome with its own approval.
   */
  async close(request: Mutation & { attemptId: string }) {
    const result = await closeProcess(request);
    return { repeated: "repeated" in result && result.repeated === true, result };
  },

  /**
   * Removes one approved Herdr worktree.
   * Accepted work is not disposal authority, so this runs only behind a closed process, an
   * accepted result, preserved evidence, remote copies of every commit, and a live approval.
   */
  async remove(request: Mutation & { attemptId: string }) {
    const result = await removeWorktree(request);
    return { repeated: "repeated" in result && result.repeated === true, result };
  },

  /** Records an explicit decision to keep one Operative's resources. It outlives the session. */
  async holdResources(request: Mutation & { attemptId: string; input: unknown }) {
    const parsed = parseInput(holdInputSchema, request.input);
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
        operation: "cleanup_hold",
        input: { attemptId: request.attemptId, ...input },
      },
      ({ tx, now }) =>
        commitOn(
          placeHold(tx, {
            holdId: crypto.randomUUID(),
            attemptId: request.attemptId,
            input,
            now,
          }),
          "held",
        ),
    );
  },

  /** Ends one retention hold. Every other cleanup gate still applies afterwards. */
  async releaseResources(request: Mutation & { attemptId: string; revision: number }) {
    return mutate(
      {
        projectRoot: request.projectRoot,
        requestId: request.requestId,
        ownerToken: request.ownerToken,
        now: new Date().toISOString(),
        operation: "cleanup_release",
        input: { attemptId: request.attemptId, revision: request.revision },
      },
      ({ tx, now }) =>
        commitOn(
          releaseHold(tx, {
            attemptId: request.attemptId,
            revision: request.revision,
            now,
          }),
          "released",
        ),
    );
  },

  /** Reports every recorded cleanup and every retention hold this crew holds. Writes nothing. */
  async cleanup(request: Located & { attemptId: string | null }) {
    return { repeated: false, result: await showCleanups(request) };
  },

  /**
   * True when one next action is a standing precondition rather than work this crew owes.
   * A caller reads this to decide what the crew can advance on its own.
   */
  isStandingAction(request: { action: string }): boolean {
    return isStandingAction(request.action);
  },

  /**
   * Reports everything this crew may do next, in one order, and writes nothing.
   * Readiness, the frontier order, dependency gates, review priority, capacity, pending
   * acknowledgements, and every recovery a restart owes are answered here, so a session never
   * keeps a second schedule of its own beside this one.
   */
  async next(request: Located & { readiness: { ready: boolean; detail: string } }) {
    const capacity = await readCapacity(request.projectRoot);
    if (capacity.status !== "ok") {
      return { repeated: false, result: capacity };
    }

    const input = { capacity: capacity.capacity, readiness: request.readiness };
    const result = await readState(request.projectRoot, (db) => ({
      stateVersion: STATE_VERSION,
      ...calculateNext(db, input),
    }));

    // A project with no crew state owes exactly one crew action, so it is answered here in the
    // same shape rather than left to a caller to build a second rendering of this report.
    return {
      repeated: false,
      result:
        result.status === "state-missing"
          ? { stateVersion: STATE_VERSION, ...calculateUnowned(input) }
          : result,
    };
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
