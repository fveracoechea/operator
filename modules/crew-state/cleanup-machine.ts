import type { OperativeCleanup } from "../operative-cleanup/main.ts";
import { storedAssignmentState } from "./assignment.ts";
import type { ApprovalCheck } from "./approval-input.ts";
import type { ApprovalRecord } from "./approvals.ts";
import { type CleanupKind, type CleanupState, type EvidenceItem } from "./cleanup.ts";
import type { CheckoutInspection, CleanupContext } from "./cleanup-context.ts";
import {
  checkoutBlockers,
  ignoredFileBlockers,
  handoffBlockers,
  headBlockers,
  holdBlocker,
  hostBlocker,
  identityBlocker,
  stillWritingBlockers,
} from "./cleanup-gates.ts";
import type { IdentityMatch } from "./cleanup-identity.ts";
import type { CleanupBlocker } from "./cleanup-report.ts";
import type { OperationState } from "./dispatch.ts";
import type { StateFailure } from "./operations.ts";

/**
 * The cleanup machine (ADR 0023). One `cleanups` row for each kind moves through
 * `CLEANUP_STATES`. A close or a remove reads the facts it needs one at a time, in the order of
 * the transition table, so every read and every effect happens exactly where the table puts it.
 */

/** The command that moves one cleanup. Each kind has its own command. */
export type CleanupEvent = "close" | "remove";

export const CLEANUP_EVENT = {
  process_closure: "close",
  worktree_removal: "remove",
} as const satisfies Record<CleanupKind, CleanupEvent>;

/** The recorded state of one cleanup, or `none` before its first record. */
export type CleanupRunState = CleanupState | "none";

type Outcome<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;

export type ApprovalOutcome =
  | { status: "covered"; approval: ApprovalRecord }
  | { status: "revoked"; approval: ApprovalRecord }
  | { status: "missing"; checks: ApprovalCheck[] }
  | { status: "unreadable"; failure: StateFailure };

/**
 * What one cleanup run knows. The context and the open operation are read when the run begins.
 * Every other fact is gathered only when the table first asks for it, and some of them are the
 * outcome of an outside effect that the interpreter runs at that point.
 */
export type CleanupFacts = {
  context: CleanupContext;
  /** The external effect this cleanup opened, in this run or in a former one. */
  operationId: string | null;
  /** True when a former run left the effect open, so this run recovers it and opens none. */
  resumed: boolean;
  inspection?: CheckoutInspection;
  identity?: IdentityMatch;
  preserved?: Outcome<typeof OperativeCleanup.preserve>;
  stopped?: Outcome<typeof OperativeCleanup.stop>;
  /** The checkout read again after the stop. */
  after?: CheckoutInspection;
  occupancy?: Outcome<typeof OperativeCleanup.occupancy>;
  /** What Herdr shows of a checkout whose removal a former run opened. */
  recovery?: Outcome<typeof OperativeCleanup.findCheckout>;
  landing?: CleanupBlocker[];
  verified?: Outcome<typeof OperativeCleanup.verify>;
  approval?: ApprovalOutcome;
  removed?: Outcome<typeof OperativeCleanup.remove>;
};

export type CleanupFact = Exclude<keyof CleanupFacts, "context" | "operationId" | "resumed">;

/** What one cleanup run does next. */
export type CleanupDecision =
  | { need: CleanupFact }
  | { next: "done"; already: true }
  | { next: "blocked"; blockers: CleanupBlocker[] }
  /** Record the intent of the outside effect before it happens. */
  | { next: "pending"; intent: unknown; detail: string }
  | {
      next: "done" | "uncertain" | "failed";
      detail: string;
      operation: OperationState;
      evidence?: EvidenceItem[];
      /** Report the row as it reads after the write, not as the run began. */
      reread: boolean;
    }
  | { stateFailure: StateFailure };

type Known<K extends CleanupFact> = CleanupFacts & Required<Pick<CleanupFacts, K>>;

type Row = {
  needs: readonly CleanupFact[];
  decide: (facts: CleanupFacts) => CleanupDecision | null;
};

/**
 * One guard of the table. It reads only the facts it names, and the table gathers them first. A
 * guard that needs a fact on only one path names it itself, with a `need` decision.
 */
function row<K extends CleanupFact>(
  needs: readonly K[],
  decide: (facts: Known<K>) => CleanupDecision | null,
): Row {
  return {
    needs,
    decide: (facts) => (knows(facts, needs) ? decide(facts) : null),
  };
}

function knows<K extends CleanupFact>(facts: CleanupFacts, needs: readonly K[]): facts is Known<K> {
  return needs.every((one) => facts[one] !== undefined);
}

function blocked(blockers: Array<CleanupBlocker | null>): CleanupDecision | null {
  const found = blockers.flatMap((one) => (one === null ? [] : [one]));
  return found.length === 0 ? null : { next: "blocked", blockers: found };
}

/** The identity a later step acts on. The table refuses every other identity before it. */
function matchedOf(facts: CleanupFacts): Extract<IdentityMatch, { status: "matched" }> {
  if (facts.identity?.status !== "matched") {
    throw new Error("A cleanup step read the identity before the identity row matched it.");
  }
  return facts.identity;
}

/** The evidence a closure preserved. The table refuses an unpreserved closure before it. */
function preservedOf(facts: CleanupFacts): EvidenceItem[] {
  if (facts.preserved?.status !== "preserved") {
    throw new Error("A closure step read the evidence before the preserve row passed.");
  }
  return facts.preserved.items;
}

/** The host decides every later reading, so a host this release cannot stop is refused first. */
const hostRow = row(["inspection"], (facts) => blocked([hostBlocker(facts.context)]));

const identityRow = row(["identity"], (facts) =>
  facts.identity.status === "matched" ? null : blocked([identityBlocker(facts.identity)]),
);

/**
 * Closes one Operative process after its work is durably handed over (ADR 0010).
 * The intent is written before the stop, so a run that dies there is recovered from what Herdr
 * shows rather than repeated blindly into a host that already ended.
 */
const CLOSE_ROWS: readonly Row[] = [
  hostRow,
  row(["inspection"], ({ context, inspection }) =>
    blocked([
      holdBlocker(context),
      ...stillWritingBlockers({ context, inspection }),
      ...handoffBlockers(context),
      ...checkoutBlockers(inspection),
    ]),
  ),
  identityRow,
  row(["preserved"], ({ preserved }) => {
    if (preserved.status === "preserved") return null;
    const { name, path } = preserved;
    return preserved.status === "evidence-missing"
      ? blocked([{ reason: "evidence_missing", name, path }])
      : blocked([
          {
            reason: "evidence_changed",
            name,
            path,
            expected: preserved.expected,
            found: preserved.found,
          },
        ]);
  }),
  row([], ({ context, operationId }) =>
    operationId === null
      ? {
          next: "pending",
          intent: { kind: "process_closure", agentName: context.dispatch.agentName },
          detail: "The supported host stop was requested.",
        }
      : null,
  ),
  row(["stopped"], (facts) => {
    const { stopped, context } = facts;
    switch (stopped.status) {
      case "host-unsupported":
        return blocked([{ reason: "host_unsupported", host: stopped.host }]);
      case "live":
        return blocked([
          {
            reason: "writer_live",
            agentName: context.dispatch.agentName,
            agentStatus: stopped.agentStatus,
          },
        ]);
      case "uncertain":
        return {
          next: "uncertain",
          detail: stopped.detail,
          evidence: preservedOf(facts),
          operation: "uncertain",
          reread: false,
        };
      default:
        return null;
    }
  }),
  // A stopped Operative writes nothing more, so the checkout must be exactly what it was when
  // this run read it. A checkout that moved was still being written while it was stopped.
  row(["inspection", "after"], ({ context, inspection, after }) =>
    after.identity === inspection.identity
      ? null
      : blocked([
          { reason: "writer_active", state: context.attempt.state, checkout: after.worktreePath },
          ...checkoutBlockers(after),
        ]),
  ),
  // A review runs its two axes as sub-agents of one host, so a stopped Operative leaves no
  // agent and no child tool behind. Whatever is still here was never accounted for.
  row(["occupancy"], ({ occupancy, context }) => {
    if (occupancy.status === "unknown") {
      return blocked([{ reason: "occupancy_unknown", detail: occupancy.detail }]);
    }
    const strangers = occupancy.occupants.filter((one) => one !== context.dispatch.agentName);
    return strangers.length === 0 && occupancy.childTools.length === 0
      ? null
      : blocked([
          {
            reason: "unfamiliar_process",
            occupants: strangers,
            childTools: occupancy.childTools.map((one) => `${one.name} (${one.pid})`),
          },
        ]);
  }),
  row([], (facts) => ({
    next: "done",
    detail: `${facts.context.dispatch.agentName} stopped on ${facts.context.dispatch.agentHost}.`,
    evidence: preservedOf(facts),
    operation: "succeeded",
    reread: true,
  })),
];

/**
 * Removes one approved Operative checkout (ADR 0010). Acceptance is not disposal authority, and a
 * checkout that holds a commit of withdrawn work or a replaced commit holds unlanded work, so it
 * is refused whatever approval exists, and only the person removes it (D3).
 */
const REMOVE_ROWS: readonly Row[] = [
  hostRow,
  row(["inspection"], ({ context, inspection }) => {
    const closure = context.cleanups.get("process_closure") ?? null;
    const state = storedAssignmentState(context.assignment.state);
    return blocked([
      holdBlocker(context),
      closure?.state === "done"
        ? null
        : { reason: "process_live", state: closure?.state ?? "none" },
      state === "accepted" || state === "withdrawn"
        ? null
        : { reason: "assignment_not_accepted", assignmentId: context.assignment.id, state },
      context.unlanded === null
        ? null
        : {
            reason: "unlanded_work",
            assignmentId: context.assignment.id,
            cause: context.unlanded.cause,
            commits: [context.unlanded.commit],
          },
      ...headBlockers({ context, inspection }),
      ...checkoutBlockers(inspection),
      ...ignoredFileBlockers(inspection),
    ]);
  }),
  // A removal that already landed but never answered is settled from what Herdr shows now,
  // ahead of every identity read, because the checkout it would read from is already gone.
  row([], ({ resumed, recovery, context }) => {
    if (!resumed) return null;
    if (recovery === undefined) return { need: "recovery" };
    if (recovery.status === "unknown") {
      return blocked([{ reason: "checkout_unknown", detail: recovery.detail }]);
    }
    return recovery.status === "absent"
      ? {
          next: "done",
          detail: `Herdr no longer holds ${context.dispatch.worktreePath}.`,
          operation: "succeeded",
          reread: false,
        }
      : null;
  }),
  // A landing with no recorded outcome is settled first, because recovery comes before new work.
  row(["landing"], ({ landing }) => blocked(landing)),
  identityRow,
  // The evidence the closure preserved must still be readable, because deletion is the last
  // moment at which the record could be repaired from the worktree.
  row(["verified"], ({ verified }) =>
    verified.status === "verified"
      ? null
      : blocked([{ reason: "preservation_failed", name: verified.name, path: verified.path }]),
  ),
  row(["approval"], ({ approval }) => {
    switch (approval.status) {
      case "unreadable":
        // The crew state holds the approvals and the cleanup record alike, so a file that
        // cannot answer is reported as itself rather than as something about the checkout.
        return { stateFailure: approval.failure };
      case "revoked":
        return blocked([{ reason: "approval_revoked", approvalId: approval.approval.approvalId }]);
      case "missing":
        return blocked(
          approval.checks.map((check) => ({
            reason: "approval_required" as const,
            action: check.action,
            targets: check.targets,
            scope: check.scope,
            requestRevision: check.requestRevision,
          })),
        );
      default:
        return null;
    }
  }),
  row(["approval"], (facts) =>
    facts.operationId === null && facts.approval.status === "covered"
      ? {
          next: "pending",
          intent: {
            kind: "worktree_removal",
            workspaceId: matchedOf(facts).checkout.workspaceId,
            worktreePath: facts.context.dispatch.worktreePath,
            approvalId: facts.approval.approval.approvalId,
          },
          detail: `Approved removal of ${facts.context.dispatch.worktreePath} was requested.`,
        }
      : null,
  ),
  row(["removed"], ({ removed }) => {
    if (removed.status === "removed") return null;
    if (removed.status === "uncertain") {
      return { next: "uncertain", detail: removed.detail, operation: "uncertain", reread: false };
    }
    const detail =
      removed.status === "failed" ? `${removed.code}: ${removed.detail}` : removed.detail;
    return { next: "failed", detail, operation: "failed", reread: false };
  }),
  row([], ({ context }) => ({
    next: "done",
    detail: `Herdr removed ${context.dispatch.worktreePath}.`,
    operation: "succeeded",
    reread: true,
  })),
];

/**
 * The transition table: the ordered guards of each event. A refused guard moves the cleanup to
 * `blocked`, a pending row to `pending`, and the last rows settle it.
 */
const CLEANUP_TABLE = {
  close: CLOSE_ROWS,
  remove: REMOVE_ROWS,
} as const satisfies Record<CleanupEvent, readonly Row[]>;

/**
 * What one stuck recorded state asks of a person. A pending cleanup is retried, and a done one
 * owes nothing, so neither names a blocker.
 */
const STUCK = {
  pending: null,
  blocked: "cleanup_blocked",
  failed: "cleanup_failed",
  uncertain: "cleanup_uncertain",
  done: null,
} as const satisfies Record<CleanupState, string | null>;

export type CleanupStuck = (typeof STUCK)[CleanupState];

/** The cleanup one ended attempt still owes, read from the recorded states of both kinds. */
export type OwedCleanup = {
  kind: CleanupKind;
  state: CleanupRunState;
  stuck: CleanupStuck;
};

export const Cleanup = {
  /**
   * Decides the next step of one cleanup run. It is pure: it reads only the state and the
   * facts, and it names the next fact to gather when a guard needs one that is not known yet.
   */
  decide(state: CleanupRunState, event: CleanupEvent, facts: CleanupFacts): CleanupDecision {
    // A finished cleanup is never repeated. It reports the outcome it already recorded.
    if (state === "done") {
      return { next: "done", already: true };
    }
    for (const one of CLEANUP_TABLE[event]) {
      const missing = one.needs.find((need) => facts[need] === undefined);
      if (missing !== undefined) {
        return { need: missing };
      }
      const decision = one.decide(facts);
      if (decision !== null) {
        return decision;
      }
    }
    throw new Error(`The ${event} table ended with no decision.`);
  },

  /**
   * The disposal one ended attempt still owes. The process closes first. A checkout is removed
   * only when it may be offered at all, and a removal that is done owes nothing.
   */
  owed(recorded: Map<CleanupKind, CleanupState>, removable: boolean): OwedCleanup | null {
    const closure = recorded.get("process_closure") ?? "none";
    if (closure !== "done") {
      return { kind: "process_closure", state: closure, stuck: Cleanup.stuck(closure) };
    }
    const removal = recorded.get("worktree_removal") ?? "none";
    return removal === "done" || !removable
      ? null
      : { kind: "worktree_removal", state: removal, stuck: Cleanup.stuck(removal) };
  },

  stuck(state: CleanupRunState): CleanupStuck {
    return state === "none" ? null : STUCK[state];
  },
};
