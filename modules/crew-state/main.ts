import { OperatorConfig } from "../operator-config/main.ts";
import { acknowledgeAttempt } from "./dispatch-acknowledge.ts";
import type { Overrides } from "./dispatch-context.ts";
import { dispatchAttempt } from "./dispatch-launch.ts";
import { reconcileAttempt } from "./dispatch-reconcile.ts";
import { replaceAttempt } from "./dispatch-replace.ts";
import { showAttempt } from "./dispatch-report.ts";
import { readCapacity } from "./capacity.ts";
import { acceptAssignment } from "./acceptance.ts";
import { claimAssignment } from "./claims.ts";
import { calculateFrontier } from "./frontier.ts";
import { mutate, readState } from "./operations.ts";
import { claimOwnership, currentOwnership } from "./ownership.ts";
import { registerWork } from "./registration.ts";
import { dispositionInputSchema } from "./review-input.ts";
import { disposeFindings, type DisposeOutcome } from "./review-dispose.ts";
import { recordReview } from "./review-record.ts";
import { showReview } from "./review-show.ts";
import { readReview } from "./review.ts";
import { submitAttemptResult } from "./submit.ts";
import { STATE_VERSION } from "./schema.ts";
import { workInputSchema } from "./work-input.ts";

type Located = { projectRoot: string };
type Mutation = Located & { requestId: string; ownerToken: string };

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
    const parsed = workInputSchema.safeParse(request.input);
    if (!parsed.success) {
      return {
        repeated: false,
        result: {
          status: "invalid-input" as const,
          issues: parsed.error.issues.map(OperatorConfig.describeIssue),
        },
      };
    }

    const input = parsed.data;
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
    const parsed = dispositionInputSchema.safeParse(request.input);
    if (!parsed.success) {
      return {
        repeated: false,
        result: {
          status: "invalid-input" as const,
          issues: parsed.error.issues.map(OperatorConfig.describeIssue),
        },
      };
    }

    const input = parsed.data;
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

  /** Starts a new attempt on the same assignment once the former writer is proven stopped. */
  async replace(request: Mutation & { attemptId: string; approvedInspection: string | null }) {
    return replaceAttempt(request);
  },

  /** Reports the recorded launch of one attempt and the state of its effects. Writes nothing. */
  async attempt(request: Located & { attemptId: string }) {
    return showAttempt(request);
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
