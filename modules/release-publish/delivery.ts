import type { PathRecord } from "./journal.ts";

export type DeliveryPathName = "github-source" | "jsr";

/** The lifecycle of one delivery path of one release. `absent` means the journal records none. */
export type DeliveryPathState = "absent" | PathRecord["state"];

/** What one send or one registry read reports, with the reference and the time it records. */
type Outcome = { detail: string; reference: string | null; at: string };

/** What each event needs to know. The caller reads it first, so the decision reads nothing. */
type DeliveryPathFacts = {
  plan: {
    path: DeliveryPathName;
    // Both paths already hold this version, so nothing is due.
    released: boolean;
    // The path holds this version now, whoever sent it.
    observed: boolean;
    // The commit the release tag names now, or null with no tag.
    taggedCommit: string | null;
    commit: string;
  };
  "send-succeeded": Outcome;
  "send-failed": Outcome;
  "send-uncertain": Outcome;
  "observed-published": Outcome;
};

export type DeliveryPathEvent = keyof DeliveryPathFacts;

type Delivered = Exclude<DeliveryPathEvent, "plan">;

type DeliveryPathRefusals = {
  plan: "tag_moved" | "version_published";
} & {
  [E in Delivered]: "already-published";
};

export type DeliveryPathEffect =
  // The path still waits for this release, so the caller sends it or records what it observed.
  { kind: "deliver"; observed: boolean } | { kind: "record"; record: PathRecord };

export type DeliveryPathDecision<E extends DeliveryPathEvent> =
  | { next: DeliveryPathState; effects: DeliveryPathEffect[] }
  | { refused: DeliveryPathRefusals[E] };

type Transition<E extends DeliveryPathEvent> = {
  // The first guard that holds gives the refusal, so the order is the refusal order.
  guards: Array<{
    refusal: DeliveryPathRefusals[E];
    holds: (state: DeliveryPathState, facts: DeliveryPathFacts[E]) => boolean;
  }>;
  next: (state: DeliveryPathState) => DeliveryPathState;
  effects: (state: DeliveryPathState, facts: DeliveryPathFacts[E]) => DeliveryPathEffect[];
};

/** A delivery this release already recorded is never sent again and never written over. */
const neverOverwritten = {
  refusal: "already-published" as const,
  holds: (state: DeliveryPathState) => state === "published",
};

function recorded<E extends Delivered>(next: PathRecord["state"]): Transition<E> {
  return {
    guards: [neverOverwritten],
    next: () => next,
    effects: (_, facts) => [
      {
        kind: "record",
        record: { state: next, detail: facts.detail, reference: facts.reference, at: facts.at },
      },
    ],
  };
}

const TRANSITIONS: { [E in DeliveryPathEvent]: Transition<E> } = {
  plan: {
    guards: [
      {
        refusal: "tag_moved",
        holds: (_, facts) =>
          facts.path === "github-source" &&
          !facts.released &&
          facts.taggedCommit !== null &&
          facts.taggedCommit !== facts.commit,
      },
      // A version this release tried to send may have landed after the client failed, so only a
      // version with no record of this release at all belongs to someone else.
      {
        refusal: "version_published",
        holds: (state, facts) =>
          facts.path === "jsr" && !facts.released && facts.observed && state === "absent",
      },
    ],
    next: (state) => state,
    effects: (state, facts) =>
      state === "published" ? [] : [{ kind: "deliver", observed: facts.observed }],
  },
  "send-succeeded": recorded("published"),
  "send-failed": recorded("failed"),
  "send-uncertain": recorded("uncertain"),
  "observed-published": recorded("published"),
};

export const DeliveryPath = {
  /** Decides one event of one delivery path. Reads nothing, so the caller gathers every fact first. */
  decide<E extends DeliveryPathEvent>(
    state: DeliveryPathState,
    event: E,
    facts: DeliveryPathFacts[E],
  ): DeliveryPathDecision<E> {
    const transition: Transition<E> = TRANSITIONS[event];
    const refused = transition.guards.find((guard) => guard.holds(state, facts));
    if (refused) {
      return { refused: refused.refusal };
    }

    return { next: transition.next(state), effects: transition.effects(state, facts) };
  },

  /** The recorded state of one path, with `absent` for a path the journal does not name. */
  state(record: PathRecord | undefined): DeliveryPathState {
    return record?.state ?? "absent";
  },
};
