import { z } from "zod";

type Row = {
  action: string;
  reason?: string;
  assignment?: string;
  question?: { key: string };
  message?: { key: string };
};
type Answer = { sources: { id: string; actions: Row[] }[] };

/**
 * One action of a coordination wait as stored text. Recorded facts beside an action, such as
 * observed activity or a wait time, change nothing, so only the source, the assignment, the
 * action, its reason, and the question or message that it names count.
 */
export function actionKey(sourceId: string, row: Row) {
  const named = row.question?.key ?? row.message?.key;
  const tuple = [sourceId, row.assignment ?? null, row.action, row.reason ?? null];
  return JSON.stringify(named === undefined ? tuple : [...tuple, named]);
}

/** The keys of the answer's actions. */
export function actionKeys(answer: Answer) {
  return new Set(
    answer.sources.flatMap((source) => source.actions.map((row) => actionKey(source.id, row))),
  );
}

const keySchema = z
  .tuple([z.string(), z.string().nullable(), z.string(), z.string().nullable()])
  .rest(z.string());

/** The source, assignment, action, reason, and named question or message of a key. */
export function parseKey(key: string) {
  return keySchema.parse(JSON.parse(key));
}

// A set from an earlier release holds tuples rather than keys, and reads as the same keys.
const storedSchema = z.array(
  z.union([z.string(), z.array(z.unknown()).transform((tuple) => JSON.stringify(tuple))]),
);

/** The stored set of keys, or null for a scope that never returned one. */
export function parseSet(stored: string | null) {
  return stored === null ? null : new Set(storedSchema.parse(JSON.parse(stored)));
}

function storeSet(keys: Set<string>) {
  return JSON.stringify([...keys].toSorted());
}

/** Adds keys to a stored set. A scope without a set gets exactly these keys. */
export function addKeys(keys: Iterable<string>) {
  return (stored: string | null) => storeSet(new Set([...(parseSet(stored) ?? []), ...keys]));
}

/** Removes keys from a stored set. */
export function dropKeys(keys: Iterable<string>) {
  const dropped = new Set(keys);
  return (stored: string | null) =>
    storeSet(new Set([...(parseSet(stored) ?? [])].filter((key) => !dropped.has(key))));
}

// These actions often clear by themselves within a minute: an owner starts its next PR wait, or a
// worker turns active again. Each wakes a wait only once it lasted the grace period.
const settlingReasons = new Set([
  "pr_wait_timed_out",
  "pr_wait_stopped",
  "pr_owner_idle",
  "worker_idle",
]);
export const settlingGraceMs = 60000;

function settling(key: string) {
  const reason = parseKey(key)[3];
  return reason !== null && settlingReasons.has(reason);
}

/** What one watch keeps between its reads. */
export type Watch = {
  /** The keys that were new at the watch's first read, which changed between two waits. */
  first: Set<string> | null;
  /** The new keys of the previous read. */
  previous: Set<string>;
  /** When the watch first read each settling key that has been new since. */
  seen: Map<string, number>;
};

export function startWatch(): Watch {
  return { first: null, previous: new Set(), seen: new Map() };
}

/**
 * The keys that end a wait now: new keys that are not in the stored set. A key that appeared
 * during the wait counts from its second read, so a command that the pane runs can acknowledge
 * its own change first. A settling key counts once it lasted the grace period. A removed key
 * never counts, so an action that turned back into a wait wakes nobody.
 */
export function dueKeys(input: {
  stored: Set<string>;
  current: Set<string>;
  watch: Watch;
  now: number;
}) {
  const { stored, current, watch, now } = input;
  const fresh = new Set([...current].filter((key) => !stored.has(key)));
  const first = watch.first ?? fresh;
  for (const key of watch.seen.keys()) if (!fresh.has(key)) watch.seen.delete(key);
  const due = [...fresh].filter((key) => {
    if (settling(key)) {
      const since = watch.seen.get(key) ?? now;
      watch.seen.set(key, since);
      return now - since >= settlingGraceMs;
    }
    return first.has(key) || watch.previous.has(key);
  });
  watch.first = first;
  watch.previous = fresh;
  return due;
}

/** The answer's sources with only the actions whose keys are given, without waits. */
export function changedAnswer(
  answer: { sources: { id: string; state: string; repository?: string; actions: Row[] }[] },
  keys: Set<string>,
) {
  return {
    sources: answer.sources.flatMap((source) => {
      const actions = source.actions.filter((row) => keys.has(actionKey(source.id, row)));
      if (actions.length === 0) return [];
      const where = source.repository === undefined ? {} : { repository: source.repository };
      return [{ id: source.id, ...where, state: source.state, actions }];
    }),
  };
}
