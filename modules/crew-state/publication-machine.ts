import type { ApprovalCheck } from "./approval-input.ts";
import { type Fault, type PartStatus, STACK_FAULT_ACTION } from "./stack-parts.ts";
import type { PublicationRow, WrittenPull } from "./stack-records.ts";
import type { RecallPlanned } from "./recall.ts";

/**
 * The stack publication machine (ADR 0022, ADR 0023). No column records it: the state of the
 * last publication of one source is derived from its writes, its readings, and its faults.
 * `none` has no publication, `unwritten` holds a write that is not done, and the other states
 * read the parts of a written publication.
 */
export type StackState =
  | "none"
  | "unwritten"
  | "faulted"
  | "ended"
  | "open"
  | "recalled"
  | "merged";

/** The state of the last publication, with what each state names. */
export type StackView =
  | { state: "none" }
  | { state: "unwritten"; publication: number }
  | { state: "faulted"; publication: number; faults: Fault[]; stopped: number[] }
  | { state: "ended"; publication: number; ended: Fault[]; stopped: number[] }
  | { state: "open"; publication: number; open: number[] }
  | { state: "recalled"; publication: number; recalled: number[]; closed: boolean }
  | { state: "merged"; publication: number };

/** The state of one write of a publication, as `publish_effects.state` records it. */
export type EffectState = "intended" | "done" | "conflict" | "failed";

/**
 * The events that move a publication. An apply records and runs a new publication or settles the
 * open one, an observe records what GitHub shows, a recall marks the open parts, a retarget moves
 * the base of one part, and a settle-fault is the approval by which a person accepts a fault.
 */
export type PublicationEvent = "apply" | "observe" | "recall" | "retarget" | "settle-fault";

/** One part of a written publication: its number and where it stands. */
export type PartRead = { part: number; number: number; status: PartStatus };

/** What the records hold of the last publication of one source, gathered by the caller. */
export type StackRead =
  | { last: "none" }
  | { last: "unwritten"; publication: number }
  | { last: "written"; publication: number; parts: PartRead[]; faults: Fault[] };

/** One part whose base changes to the target next (decision 15). */
export type RetargetDue = {
  publicationId: string;
  part: number;
  number: number;
  from: string;
  target: string;
  approval: ApprovalCheck;
  approved: boolean;
};

/** What each event reads before it decides. The caller gathers these facts. */
export type PublicationFacts = {
  apply: {
    stated: string;
    /** The publication of the source with a write that is not done. */
    open: { id: string; planRevision: string } | null;
  };
  observe: {
    sourceId: string;
    known: boolean;
    stack: StackView;
    /** The last publication once every write of it is done, with its pull requests. */
    written: { publication: PublicationRow; pulls: WrittenPull[] } | null;
    /** The tracker repository of the source, or null when the source records none. */
    repository: string | null;
  };
  recall: {
    sourceId: string;
    known: boolean;
    /** The publication whose open writes carry the stated recall plan revision. */
    open: string | null;
    /** The recall the source owes now, rendered, or null for none. */
    planned: RecallPlanned | null;
  };
  retarget: {
    sourceId: string;
    part: number;
    known: boolean;
    stack: StackView;
    due: RetargetDue | null;
    /** The lowest part with a fault, or infinity for none. */
    lowest: number;
  };
  "settle-fault": { action: string };
};

/** The refusals of each event. */
export type PublicationRefusal = {
  apply: { status: "plan-revision-changed"; stated: string; planned: string; planPath: null };
  observe:
    | { status: "unknown-source"; sourceId: string }
    | { status: "nothing-published"; sourceId: string }
    | { status: "publish-unsettled"; sourceId: string; publication: number };
  recall:
    | { status: "unknown-source"; sourceId: string }
    | { status: "nothing-to-recall"; sourceId: string };
  retarget:
    | { status: "unknown-source"; sourceId: string }
    | { status: "publish-unsettled"; sourceId: string }
    | { status: "stack-fault"; part: number; detail: string }
    | { status: "not-due"; part: number; detail: string }
    | { status: "approval-required"; approval: ApprovalCheck };
  "settle-fault": { status: "not-stack-fault" };
};

/** What each event does next. A settle repeats the open writes, which read GitHub first. */
export type PublicationNext = {
  apply: { kind: "settle"; publicationId: string } | { kind: "record" };
  observe: {
    kind: "read";
    publication: PublicationRow;
    pulls: WrittenPull[];
    repository: string;
  };
  recall: { kind: "settle"; publicationId: string } | { kind: "plan"; planned: RecallPlanned };
  retarget: { kind: "write"; due: RetargetDue };
  "settle-fault": { kind: "settled"; effects: ["close-merged-invalidations"] };
};

type Guard<F, R> = (facts: F) => R | null;

type Entry<E extends PublicationEvent> = {
  /** A publication with a write that is not done is settled first, before any guard (ADR 0022). */
  settle: (facts: PublicationFacts[E]) => PublicationNext[E] | null;
  guards: Array<Guard<PublicationFacts[E], PublicationRefusal[E]>>;
  next: (facts: PublicationFacts[E]) => PublicationNext[E];
};

const NO_SETTLE = () => null;

/** A fact that the guards of an event proved present. A null here is a broken table. */
function proven<T>(value: T | null): T {
  if (value === null) {
    throw new Error("A stack publication event passed its guards with a fact missing.");
  }
  return value;
}

/** The transition table of a stack publication: the settle, the guards in order, and the next. */
const PUBLICATION_TABLE: { [E in PublicationEvent]: Entry<E> } = {
  apply: {
    settle: ({ open, stated }) =>
      open !== null && open.planRevision === stated
        ? { kind: "settle", publicationId: open.id }
        : null,
    // The open publication is settled under its own plan revision, never under another one.
    guards: [
      ({ open, stated }) =>
        open === null
          ? null
          : { status: "plan-revision-changed", stated, planned: open.planRevision, planPath: null },
    ],
    next: () => ({ kind: "record" }),
  },
  observe: {
    settle: NO_SETTLE,
    guards: [
      ({ known, sourceId }) => (known ? null : { status: "unknown-source", sourceId }),
      ({ stack, sourceId }) =>
        stack.state === "none" ? { status: "nothing-published", sourceId } : null,
      // GitHub is read only for a publication whose writes are done, in a repository it knows.
      ({ stack, repository, sourceId }) =>
        stack.state === "none" || (stack.state !== "unwritten" && repository !== null)
          ? null
          : { status: "publish-unsettled", sourceId, publication: stack.publication },
    ],
    next: ({ written, repository }) => ({
      kind: "read",
      ...proven(written),
      repository: proven(repository),
    }),
  },
  recall: {
    settle: ({ open }) => (open === null ? null : { kind: "settle", publicationId: open }),
    guards: [
      ({ known, sourceId }) => (known ? null : { status: "unknown-source", sourceId }),
      ({ planned, sourceId }) =>
        planned === null ? { status: "nothing-to-recall", sourceId } : null,
    ],
    next: ({ planned }) => ({ kind: "plan", planned: proven(planned) }),
  },
  retarget: {
    settle: NO_SETTLE,
    guards: [
      ({ known, sourceId }) => (known ? null : { status: "unknown-source", sourceId }),
      ({ stack, sourceId }) =>
        stack.state === "unwritten" ? { status: "publish-unsettled", sourceId } : null,
      // A fault stops its own part and every part above it, so each keeps its base.
      ({ due, part, lowest }) =>
        due !== null || part < lowest
          ? null
          : {
              status: "stack-fault",
              part,
              detail:
                part === lowest
                  ? `Part ${part} holds a stack fault, so it is stopped and keeps its base.`
                  : `Part ${lowest} holds a stack fault, so part ${part} is stopped and keeps its base.`,
            },
      ({ due, part }) =>
        due !== null
          ? null
          : {
              status: "not-due",
              part,
              detail: `Part ${part} has no retarget due: the part below has no recorded merge by a merge commit, or its retarget is recorded.`,
            },
      ({ due }) =>
        due === null || due.approved
          ? null
          : { status: "approval-required", approval: due.approval },
    ],
    next: ({ due }) => ({ kind: "write", due: proven(due) }),
  },
  // Only a `stack-fault` approval settles a fault. A settled merge before a recall ends the
  // change that its invalidation asked for (decision 24).
  "settle-fault": {
    settle: NO_SETTLE,
    guards: [
      ({ action }) => (action === STACK_FAULT_ACTION ? null : { status: "not-stack-fault" }),
    ],
    next: () => ({ kind: "settled", effects: ["close-merged-invalidations"] }),
  },
};

/**
 * The state of the last publication. A settled fault of a merge by another method counts as
 * landed, because its commits reached the target. Any other settled fault ends its part, and a
 * part above a fault is stopped: their commits reach the target only through a new publication.
 * A recalled part waits for that publication too, or is closed by its recall when no new
 * publication will replace it (decisions 20, 23, and 30).
 */
function stateOf(read: StackRead): StackView {
  if (read.last !== "written") {
    return read.last === "none"
      ? { state: "none" }
      : { state: "unwritten", publication: read.publication };
  }
  const { publication, parts, faults } = read;
  const lowest = faults[0]?.part ?? Number.POSITIVE_INFINITY;
  const faulted = new Set(faults.map((one) => one.part));
  const stopped = parts
    .filter((one) => one.part > lowest && !faulted.has(one.part) && one.status === "open")
    .map((one) => one.part);
  const unsettled = faults.filter((one) => !one.settled);
  if (unsettled.length > 0) {
    return { state: "faulted", publication, faults: unsettled, stopped };
  }
  const ended = faults.filter((one) => one.fault !== "not_merge_commit");
  if (ended.length > 0 || stopped.length > 0) {
    return { state: "ended", publication, ended, stopped };
  }
  const open = parts.filter((one) => one.status === "open" && !faulted.has(one.part));
  if (open.length > 0) {
    return { state: "open", publication, open: open.map((one) => one.number) };
  }
  const recalled = parts.filter((one) => one.status === "recalled" || one.status === "closed");
  return recalled.length > 0
    ? {
        state: "recalled",
        publication,
        recalled: recalled.map((one) => one.number),
        closed: recalled.every((one) => one.status === "closed"),
      }
    : { state: "merged", publication };
}

export const Publication = {
  /** The state of the last publication of one source, from the records the caller read. */
  stateOf,

  /**
   * Decides one event on the stack publication of one source. It is pure: it reads only the
   * facts the caller gathered. An open write is settled first, then the first refusal in the
   * order of the table wins, or the event moves on.
   */
  decide<E extends PublicationEvent>(
    event: E,
    facts: PublicationFacts[E],
  ): { refused: PublicationRefusal[E] } | { next: PublicationNext[E] } {
    const entry: Entry<E> = PUBLICATION_TABLE[event];
    const settle = entry.settle(facts);
    if (settle !== null) {
      return { next: settle };
    }
    for (const guard of entry.guards) {
      const refused = guard(facts);
      if (refused !== null) {
        return { refused };
      }
    }
    return { next: entry.next(facts) };
  },
};
