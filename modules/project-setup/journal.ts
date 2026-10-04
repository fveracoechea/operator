import { z } from "zod";
import type { SetupChange, SetupPlan } from "./plan.ts";

export const JOURNAL_PATH = ".operator/local/setup-journal.json";

const journalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: z.string(),
  status: z.enum(["in-progress", "complete", "rolled-back"]),
  writes: z.array(
    z.strictObject({
      path: z.string(),
      existedBefore: z.boolean(),
      previousText: z.string().nullable(),
      previousSha: z.string().nullable(),
      writtenSha: z.string(),
    }),
  ),
});

export type Journal = z.infer<typeof journalSchema>;

export type JournalRead =
  | { state: "missing" }
  | { state: "unreadable"; detail: string }
  | { state: "read"; journal: Journal };

export async function readJournal(projectRoot: string): Promise<JournalRead> {
  const file = Bun.file(`${projectRoot}/${JOURNAL_PATH}`);
  if (!(await file.exists())) {
    return { state: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    return { state: "unreadable", detail: String(error) };
  }

  const result = journalSchema.safeParse(parsed);
  if (!result.success) {
    return {
      state: "unreadable",
      detail: result.error.issues.map((issue) => issue.message).join("; "),
    };
  }

  return { state: "read", journal: result.data };
}

export async function writeJournal(projectRoot: string, journal: Journal): Promise<void> {
  await Bun.write(`${projectRoot}/${JOURNAL_PATH}`, `${JSON.stringify(journal, null, 2)}\n`, {
    createPath: true,
  });
}

/** The lifecycle of one setup apply. `absent` means no journal is recorded. */
export type SetupApplyState = "absent" | Journal["status"];

type JournalWrite = Journal["writes"][number];

/** What each event needs to know. The caller reads it first, so the decision reads nothing. */
type SetupApplyFacts = {
  apply: { plan: SetupPlan; approvedPlanId: string | undefined };
  "file-written": { remaining: number };
  "write-failed": Record<string, never>;
  rollback: { files: Array<{ write: JournalWrite; currentSha: string | null }> };
};

export type SetupApplyEvent = keyof SetupApplyFacts;

type SetupApplyRefusals = {
  apply: "recovery-pending" | "conflict" | "approval-required" | "approval-stale" | "unchanged";
  "file-written": "not-started";
  "write-failed": "not-started";
  rollback: "nothing" | "complete";
};

export type RollbackVerdict = "restore" | "already-previous" | "preserve";

export type SetupApplyEffect =
  | { kind: "write"; change: SetupChange }
  // A restore with no previous text removes the file setup created.
  | { kind: "rollback"; path: string; verdict: RollbackVerdict; previousText: string | null };

export type SetupApplyDecision<E extends SetupApplyEvent> =
  | { next: Journal["status"]; effects: SetupApplyEffect[] }
  | { refused: SetupApplyRefusals[E] };

type Transition<E extends SetupApplyEvent> = {
  // The first guard that holds gives the refusal, so the order is the refusal order.
  guards: Array<{
    refusal: SetupApplyRefusals[E];
    holds: (state: SetupApplyState, facts: SetupApplyFacts[E]) => boolean;
  }>;
  next: (facts: SetupApplyFacts[E]) => Journal["status"];
  effects: (facts: SetupApplyFacts[E]) => SetupApplyEffect[];
};

const notStarted = {
  refusal: "not-started" as const,
  holds: (state: SetupApplyState) => state !== "in-progress",
};

/** A file is restored only when it still holds what setup wrote. Later user edits stay. */
const ROLLBACK_VERDICTS: Array<{
  verdict: RollbackVerdict;
  holds: (write: JournalWrite, currentSha: string | null) => boolean;
}> = [
  { verdict: "restore", holds: (write, currentSha) => currentSha === write.writtenSha },
  // The write never landed, so the file already holds its previous contents.
  { verdict: "already-previous", holds: (write, currentSha) => currentSha === write.previousSha },
  { verdict: "preserve", holds: () => true },
];

const TRANSITIONS: { [E in SetupApplyEvent]: Transition<E> } = {
  apply: {
    guards: [
      // A pending recovery record must be resolved first, or rollback would lose the original files.
      { refusal: "recovery-pending", holds: (state) => state === "in-progress" },
      { refusal: "conflict", holds: (_, facts) => facts.plan.conflicts.length > 0 },
      { refusal: "approval-required", holds: (_, facts) => facts.approvedPlanId === undefined },
      {
        refusal: "approval-stale",
        holds: (_, facts) => facts.approvedPlanId !== facts.plan.planId,
      },
      { refusal: "unchanged", holds: (_, facts) => facts.plan.changes.length === 0 },
    ],
    next: () => "in-progress",
    effects: (facts) => facts.plan.changes.map((change) => ({ kind: "write", change })),
  },
  "file-written": {
    guards: [notStarted],
    next: (facts) => (facts.remaining === 0 ? "complete" : "in-progress"),
    effects: () => [],
  },
  // The journal stays in progress, so rollback can restore the writes that landed.
  "write-failed": { guards: [notStarted], next: () => "in-progress", effects: () => [] },
  rollback: {
    guards: [
      { refusal: "nothing", holds: (state) => state === "absent" || state === "rolled-back" },
      { refusal: "complete", holds: (state) => state === "complete" },
    ],
    next: () => "rolled-back",
    effects: (facts) =>
      facts.files.toReversed().map(({ write, currentSha }) => ({
        kind: "rollback",
        path: write.path,
        verdict:
          ROLLBACK_VERDICTS.find((row) => row.holds(write, currentSha))?.verdict ?? "preserve",
        previousText: write.existedBefore ? write.previousText : null,
      })),
  },
};

export const SetupApply = {
  /** Decides one event of a setup apply. Reads no file, so the caller gathers every fact first. */
  decide<E extends SetupApplyEvent>(
    state: SetupApplyState,
    event: E,
    facts: SetupApplyFacts[E],
  ): SetupApplyDecision<E> {
    const transition: Transition<E> = TRANSITIONS[event];
    const refused = transition.guards.find((guard) => guard.holds(state, facts));
    if (refused) {
      return { refused: refused.refusal };
    }

    return { next: transition.next(facts), effects: transition.effects(facts) };
  },
};
