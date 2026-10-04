import type { IntegrationBranch } from "../integration-branch/main.ts";
import type { GateKey } from "./gate-runs.ts";
import type { RewriteRecord } from "./landing-record.ts";

/*
 * The branch move machine (ADR 0020, ADR 0023). Each move of the integration branch of one source
 * is recorded as an intent before the ref moves, and its outcome is recorded after the ref moved.
 * A landing row and a rebase row each go from `intended` to an end state, and the other landings
 * that the move rebuilds go to their end state in the same transaction. The branch ref itself has
 * no state: it moves only by a compare and swap from the recorded tip.
 */

/** The states of one `landings` row. */
export type LandingState = "intended" | "landed" | "replaced" | "taken-out" | "merged";

/** The states of one `integration_rebases` row. */
export type RebaseState = "intended" | "rebased";

/**
 * The states of a landing whose commit still carries its accepted result: on the branch, or
 * merged into the target by its pull request, which a rebase then leaves below the new base.
 */
export const CARRYING: LandingState[] = ["landed", "merged"];

const LANDING_KINDS = ["fast-forward", "merge", "held", "rewrite", "take-out"] as const;

/** How one move puts its commit on the branch, as the `kind` column records it. */
export type LandingKind = (typeof LANDING_KINDS)[number];

/** The kind that one recorded landing names. A kind this release does not know is a fast-forward. */
export function landingKindOf(kind: string): LandingKind {
  return LANDING_KINDS.find((one) => one === kind) ?? "fast-forward";
}

/**
 * True when a move of this kind rebuilds the branch above an older commit, a rewrite or a
 * take-out. Such a move changes the commit of every later landing until it settles.
 */
export function rebuildsBranch(kind: string): boolean {
  return kind === "rewrite" || kind === "take-out";
}

/**
 * The refusals of a landing, members of the durable unions of ADR 0011. Each one lands nothing
 * and records nothing. Operator never resets the branch and never adopts a tip it did not
 * record, so a person puts a moved branch back.
 */
export type LandingRefusal =
  | { status: "integration-branch-missing"; assignmentId: string; sourceId: string }
  | {
      status: "integration-branch-moved";
      assignmentId: string;
      branch: string;
      recordedTip: string;
      found: string | null;
      checkedOut: string[];
    }
  | {
      status: "integration-branch-checked-out";
      assignmentId: string;
      branch: string;
      worktrees: string[];
    }
  | { status: "integration-branch-unread"; assignmentId: string; branch: string; detail: string }
  | {
      status: "landing-conflict";
      assignmentId: string;
      branch: string;
      tip: string;
      commit: string;
      paths: string[];
    }
  | {
      status: "landing-patch-changed";
      assignmentId: string;
      branch: string;
      tip: string;
      commit: string;
    }
  | {
      status: "landing-gate-not-passed";
      assignmentId: string;
      gate: "gate_pending" | "gate_running" | "gate_failed" | "gate_flaky";
      // The planned commit is the candidate, and its key is its tree and the fixed gate.
      commit: string;
      tip: string;
      key: GateKey;
      runIds: string[];
    }
  | {
      // A rewrite of a commit inside a published range, which is never rewritten in place.
      status: "rewrite-published-range";
      assignmentId: string;
      branch: string;
      commit: string;
      pullRequest: number | null;
      url: string | null;
    }
  | {
      // A rewrite that would move back a result whose tracker step already ran. The ticket would
      // say the work is done while its commit leaves the branch, so a person decides (#114).
      status: "rewrite-tracker-recorded";
      assignmentId: string;
      branch: string;
      steps: Array<{ assignmentId: string; step: string; state: string }>;
    }
  | {
      // A landing of a source whose integration branch still holds a withdrawn commit. The
      // take-out rebuilds the branch first, so no landing is gated twice (ADR 0020).
      status: "take-out-pending";
      assignmentId: string;
      sourceId: string;
      commits: Array<{ assignmentId: string; commit: string }>;
    }
  | {
      status: "landing-pending";
      assignmentId: string;
      landingId: string;
      pendingAssignmentId: string;
    }
  | {
      // A rebase of the source moves the branch, and its outcome is not recorded (ADR 0022).
      status: "rebase-pending";
      assignmentId: string;
      rebaseId: string;
      planRevision: string;
    }
  | {
      // The recorded tip moved between the plan and its intent, so the plan is made again.
      status: "landing-tip-changed";
      assignmentId: string;
      planned: string;
      recordedTip: string | null;
    };

/** The refusals that a landing plan itself gives. */
export type PlanRefusal = Extract<
  LandingRefusal,
  {
    status:
      | "integration-branch-moved"
      | "integration-branch-checked-out"
      | "integration-branch-unread"
      | "landing-conflict"
      | "landing-patch-changed"
      | "rewrite-published-range"
      | "rewrite-tracker-recorded";
  }
>;

const REFUSAL_CODES: { [S in LandingRefusal["status"]]: true } = {
  "integration-branch-missing": true,
  "integration-branch-moved": true,
  "integration-branch-checked-out": true,
  "integration-branch-unread": true,
  "landing-conflict": true,
  "landing-patch-changed": true,
  "landing-gate-not-passed": true,
  "rewrite-published-range": true,
  "rewrite-tracker-recorded": true,
  "take-out-pending": true,
  "landing-pending": true,
  "rebase-pending": true,
  "landing-tip-changed": true,
};

type Refused<R> = Extract<R, { status: LandingRefusal["status"] }>;

/**
 * One result of a command that moves the branch, with every landing refusal given as one
 * `landing-refused` variant that carries the refusal. A caller reads the refusal code from it and
 * maps no move state of its own.
 */
export function landingRefused<R extends { status: string }>(
  result: R,
): Exclude<R, Refused<R>> | { status: "landing-refused"; refusal: Refused<R> } {
  return isRefused(result)
    ? { status: "landing-refused", refusal: result }
    : (result as Exclude<R, Refused<R>>);
}

function isRefused<R extends { status: string }>(result: R): result is Refused<R> {
  return Object.hasOwn(REFUSAL_CODES, result.status);
}

/** Every refused outcome of a plan or a move of `IntegrationBranch`. */
type BranchOutcome = Exclude<
  | Awaited<ReturnType<typeof IntegrationBranch.plan>>
  | Awaited<ReturnType<typeof IntegrationBranch.move>>,
  { status: "ready" | "moved" }
>;

/**
 * Where one plan or move of the branch stands: the assignment it is for, the branch, its recorded
 * tip, and the tip and the commit that land. A conflict or a changed patch names that tip.
 */
export type BranchPlace = {
  assignmentId: string;
  branch: string;
  recordedTip: string;
  tip: string;
  commit: string;
};

/** The landing refusal of one refused plan or move of the branch. */
export function branchRefusalOf(outcome: BranchOutcome, place: BranchPlace): PlanRefusal {
  const subject = { assignmentId: place.assignmentId, branch: place.branch };
  switch (outcome.status) {
    case "tip-moved":
      return {
        status: "integration-branch-moved",
        ...subject,
        recordedTip: place.recordedTip,
        found: outcome.found,
        checkedOut: outcome.checkedOut,
      };
    case "checked-out":
      return { status: "integration-branch-checked-out", ...subject, worktrees: outcome.worktrees };
    case "conflict":
      return {
        status: "landing-conflict",
        ...subject,
        tip: place.tip,
        commit: place.commit,
        paths: outcome.paths,
      };
    case "patch-changed":
      return { status: "landing-patch-changed", ...subject, tip: place.tip, commit: place.commit };
    default:
      return { status: "integration-branch-unread", ...subject, detail: outcome.detail };
  }
}

/** The outcome of one move of the branch ref. */
export type MoveOutcome = Awaited<ReturnType<typeof IntegrationBranch.move>>;

/** The events that end one recorded move. */
export type MoveEvent = "land" | "take-out" | "rebase";

/** One landing row that a move ends or lands, and whether its landing time is the move time. */
export type LandingWrite = { landingId: string; state: LandingState; stamped: boolean };

/** The rebase rows and the landing rows that one move writes in the transaction of its outcome. */
export type MoveNext = { landings: LandingWrite[]; rebase: RebaseState | null };

/**
 * What each event reads before it decides. The caller gathers these facts. `moved` is the
 * outcome of the ref move, or `moved` when the branch already holds the planned tip.
 */
export type MoveFacts = {
  /** An accepted result lands, plainly or as a correction that rewrites the branch. */
  land: {
    moved: MoveOutcome;
    place: BranchPlace;
    landingId: string;
    rewrite: RewriteRecord | null;
  };
  /**
   * The commits of withdrawn work leave the branch. With no rewrite, no commit leaves, because a
   * result that is not withdrawn shares it, and only the record of each pending landing ends.
   */
  "take-out": {
    moved: MoveOutcome;
    place: BranchPlace;
    landingId: string | null;
    rewrite: RewriteRecord | null;
    pending: string[];
  };
  /** The branch moves onto a new base, and the merged landings leave it below that base. */
  rebase: {
    moved: MoveOutcome;
    rebase: { id: string; branch: string; fromTip: string; toTip: string };
    merged: string[];
    takenOut: string[];
  };
};

/** The refusals of each event. A refused move records nothing and keeps the intent open. */
export type MoveRefusal = {
  land: PlanRefusal;
  "take-out": PlanRefusal;
  rebase: {
    status: "rebase-stopped";
    rebaseId: string;
    reason:
      | "integration_branch_moved"
      | "integration_branch_checked_out"
      | "integration_branch_unread";
    detail: string;
  };
};

const ended = (state: LandingState) => (landingId: string) => ({
  landingId,
  state,
  stamped: false,
});

/**
 * The landings that one rebuild ends: the replaced one, each other withdrawn one that leaves with
 * it, and each later one that does not land again. A take-out puts nothing in the place of the
 * withdrawn commits, so the replaced one is taken out as well.
 */
function rebuilt(rewrite: RewriteRecord | null): LandingWrite[] {
  if (rewrite === null) {
    return [];
  }
  return [
    ended(rewrite.takeOut === null ? "replaced" : "taken-out")(rewrite.replaces),
    ...(rewrite.takeOut?.removed ?? []).map((one) => ended("taken-out")(one.landingId)),
    ...rewrite.takenOut.map((one) => ended("taken-out")(one.landingId)),
  ];
}

type Entry<E extends MoveEvent> = {
  refusal: (
    facts: MoveFacts[E],
    moved: Exclude<MoveOutcome, { status: "moved" }>,
  ) => MoveRefusal[E];
  next: (facts: MoveFacts[E]) => MoveNext;
};

/** The transition table of a branch move: the refusal of a ref that did not move, and the next states. */
const MOVE_TABLE: { [E in MoveEvent]: Entry<E> } = {
  land: {
    refusal: ({ place }, moved) => branchRefusalOf(moved, place),
    next: ({ landingId, rewrite }) => ({
      landings: [{ landingId, state: "landed", stamped: true }, ...rebuilt(rewrite)],
      rebase: null,
    }),
  },
  "take-out": {
    refusal: ({ place }, moved) => branchRefusalOf(moved, place),
    next: ({ landingId, rewrite, pending }) => ({
      landings: [
        ...(landingId === null ? [] : [{ landingId, state: "taken-out" as const, stamped: true }]),
        ...(rewrite === null ? pending.map(ended("taken-out")) : rebuilt(rewrite)),
      ],
      rebase: null,
    }),
  },
  rebase: {
    refusal: ({ rebase }, moved) => {
      const stopped = { status: "rebase-stopped" as const, rebaseId: rebase.id };
      switch (moved.status) {
        case "tip-moved":
          return {
            ...stopped,
            reason: "integration_branch_moved",
            detail: `The branch ${rebase.branch} holds ${moved.found ?? "no commit"}, and the rebase moves it from ${rebase.fromTip} to ${rebase.toTip}. The person puts it back.`,
          };
        case "checked-out":
          return {
            ...stopped,
            reason: "integration_branch_checked_out",
            detail: `The branch ${rebase.branch} is checked out in ${moved.worktrees.join(", ")}.`,
          };
        default:
          return { ...stopped, reason: "integration_branch_unread", detail: moved.detail };
      }
    },
    next: ({ merged, takenOut }) => ({
      landings: [...merged.map(ended("merged")), ...takenOut.map(ended("taken-out"))],
      rebase: "rebased",
    }),
  },
};

export const BranchMove = {
  /**
   * Decides the outcome of one recorded move. It is pure: it reads only the facts the caller
   * gathered. A ref that did not move gives the refusal of the event and records nothing, and a
   * moved ref gives the next state of each row that the move ends.
   */
  decide<E extends MoveEvent>(
    event: E,
    facts: MoveFacts[E],
  ): { refused: MoveRefusal[E] } | { next: MoveNext } {
    const entry: Entry<E> = MOVE_TABLE[event];
    const { moved } = facts;
    return moved.status === "moved"
      ? { next: entry.next(facts) }
      : { refused: entry.refusal(facts, moved) };
  },
};
