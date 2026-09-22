import { OperativeCleanup } from "../operative-cleanup/main.ts";
import { identityOf } from "./identity.ts";
import type { CheckoutInspection, CleanupContext } from "./cleanup-context.ts";
import type { IdentityMatch } from "./cleanup-identity.ts";
import type { CleanupBlocker } from "./cleanup-report.ts";
import { storedRequirements } from "./work-input.ts";

/** Names the blocker one failed identity reading carries. */
export function identityBlocker(
  match: Exclude<IdentityMatch, { status: "matched" }>,
): CleanupBlocker {
  if (match.status === "workspace-handle-missing") {
    return { reason: "workspace_handle_missing", missing: match.missing };
  }
  if (match.status === "unrelated-resource") {
    return {
      reason: "unrelated_resource",
      worktreePath: match.worktreePath,
      detail: match.detail,
    };
  }
  if (match.status === "checkout-in-use") {
    return { reason: "checkout_in_use", attemptIds: match.attemptIds };
  }
  if (match.status === "checkout-unknown") {
    return { reason: "checkout_unknown", detail: match.detail };
  }
  // Operator acts on Herdr-managed checkouts and nothing else, so a path Herdr does not hold
  // is refused rather than taken apart by Git or by the filesystem.
  if (match.status === "checkout-absent") {
    return {
      reason: "unrelated_resource",
      worktreePath: match.worktreePath,
      detail: "Herdr holds no worktree at that path, and Operator touches nothing else.",
    };
  }

  return { reason: "identity_mismatch", mismatches: match.mismatches };
}

/**
 * Refuses a host this release cannot stop.
 * The host decides which paths Operator wrote, which keys stop it, and which pane it occupies,
 * so every later reading of the checkout and the workspace rests on knowing it.
 */
export function hostBlocker(context: CleanupContext): CleanupBlocker | null {
  return OperativeCleanup.canStop({ agentHost: context.dispatch.agentHost })
    ? null
    : { reason: "host_unsupported", host: context.dispatch.agentHost };
}

/** An explicit retention hold stops every cleanup of its attempt until a person releases it. */
export function holdBlocker(context: CleanupContext): CleanupBlocker | null {
  return context.hold === null
    ? null
    : { reason: "retention_hold", holdReason: context.hold.reason, detail: context.hold.detail };
}

/**
 * The gates that prove one Operative finished and handed its work over.
 * A result that was never submitted, a source that moved under it, and a question it still
 * waits on each leave the crew resources exactly where they are.
 */
export function handoffBlockers(context: CleanupContext): CleanupBlocker[] {
  const blockers: CleanupBlocker[] = [];
  const { submission, review, assignment } = context;

  if (submission === null) {
    // A review submits nothing of its own; its two axis reports are its handoff.
    // An attempt that is still the live writer is reported by its own gate, not as a missing
    // handoff, so the two say different things about the same attempt.
    if (context.attempt.state === "active") {
      // The stopped-writing gate names this one.
    } else if (review === null || review.assignmentId !== assignment.id) {
      blockers.push({
        reason: "handoff_missing",
        detail: "This attempt handed over no submitted result.",
      });
    } else if (review.state !== "reported") {
      blockers.push({
        reason: "handoff_missing",
        detail: `Review ${review.id} is ${review.state}, so it reported nothing to preserve.`,
      });
    }
  } else {
    if (submission.sourceRevision !== assignment.sourceRevision) {
      blockers.push({
        reason: "revisions_changed",
        input: "source-revision",
        recorded: submission.sourceRevision,
        found: assignment.sourceRevision,
      });
    }

    const requirements = identityOf(storedRequirements(assignment.acceptanceRequirements));
    if (submission.requirementsIdentity !== requirements) {
      blockers.push({
        reason: "revisions_changed",
        input: "acceptance-requirements",
        recorded: submission.requirementsIdentity,
        found: requirements,
      });
    }
  }

  if (context.openQuestion !== null) {
    blockers.push({
      reason: "question_open",
      questionId: context.openQuestion.id,
      state: context.openQuestion.state,
    });
  }

  return blockers;
}

/**
 * The gate that proves the Operative stopped writing before anything is disposed of.
 * An attempt Herdr still counts as the live writer, with nothing handed over, is working now,
 * whatever its checkout happens to look like at this instant.
 */
export function stillWritingBlockers(request: {
  context: CleanupContext;
  inspection: CheckoutInspection;
}): CleanupBlocker[] {
  const { context } = request;
  const handedOver =
    context.submission !== null ||
    (context.review !== null &&
      context.review.assignmentId === context.assignment.id &&
      context.review.state === "reported");

  return context.attempt.state === "active" && !handedOver
    ? [
        {
          reason: "writer_active",
          state: context.attempt.state,
          checkout: request.inspection.worktreePath,
        },
      ]
    : [];
}

/**
 * The gates the checkout itself answers.
 * Work nobody registered, files a default status listing hides, and commits no remote keeps
 * are each a reason to retain the checkout rather than to discard uncertain work.
 */
export function checkoutBlockers(
  inspection: CheckoutInspection,
  options: { requireRemote: boolean },
): CleanupBlocker[] {
  const blockers: CleanupBlocker[] = [];

  if (inspection.unexpectedWork.length > 0) {
    blockers.push({ reason: "unexpected_work", paths: inspection.unexpectedWork });
  }
  if (inspection.unknownIgnored.length > 0) {
    blockers.push({ reason: "unexpected_files", paths: inspection.unknownIgnored });
  }
  if (options.requireRemote && inspection.unpushed.length > 0) {
    blockers.push({ reason: "unpushed_commits", commits: inspection.unpushed });
  }

  return blockers;
}
