import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { PullRequestStack } from "../pull-request-stack/main.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import {
  publishEffects,
  stackObservations,
  stackPublications,
  stackPullRequests,
  workSources,
} from "./schema.ts";
import { readStored, readStoredValue } from "./stored.ts";
import { storedTrackerLocation } from "./work-input.ts";

/*
 * The records of the stack publications of one source: each publication, its pull requests, the
 * log of its writes, and the readings of GitHub. publish, recall, retarget, and the stack state
 * all read and append them here, so no reader keeps a copy of its own.
 */

export type PublicationRow = typeof stackPublications.$inferSelect;
export type PullRow = typeof stackPullRequests.$inferSelect;
export type EffectRow = typeof publishEffects.$inferSelect;

type Observed = Extract<Awaited<ReturnType<typeof PullRequestStack.observe>>, { status: "read" }>;

/** A GitHub outcome that no stack publication planned (decision 21), as a reading records it. */
type StackFault = NonNullable<Observed["seen"][number]["fault"]>;

/**
 * Each fault name of a published part: what a reading recorded, or a merge of a part that held a
 * commit to change before any recall (decision 24).
 */
export type FaultName = StackFault | "merged_before_recall";

// Each name the module can record, and no other, so a new fault name fails the typecheck here.
const STACK_FAULTS = {
  closed_unmerged: "closed_unmerged",
  base_not_target: "base_not_target",
  head_moved: "head_moved",
  not_merge_commit: "not_merge_commit",
} as const satisfies { [Name in StackFault]: Name };

const stackFaultSchema = z.enum(STACK_FAULTS);

/** One reading of one part, with its fault parsed into a fault name. */
export type ObservationRow = Omit<typeof stackObservations.$inferSelect, "fault"> & {
  fault: StackFault | null;
};

const effectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("push"),
    remote: z.string(),
    refs: z.array(z.strictObject({ name: z.string(), commit: z.string() })),
  }),
  z.strictObject({
    kind: z.literal("create"),
    repository: z.string(),
    head: z.string(),
    base: z.string(),
    title: z.string(),
    body: z.string(),
  }),
  z.strictObject({
    kind: z.literal("retarget"),
    repository: z.string(),
    number: z.int(),
    from: z.string(),
    base: z.string(),
  }),
  z.strictObject({
    kind: z.literal("recall"),
    repository: z.string(),
    number: z.int(),
    comment: z.string(),
    marker: z.string(),
    /** The recall plan revision that the `stack-recall` approval binds (D1). */
    recall: z.string(),
  }),
  z.strictObject({
    kind: z.literal("close"),
    repository: z.string(),
    number: z.int(),
    /** The publication that replaces it, or null when a recall closes it with no replacement. */
    publication: z.int().nullable(),
    /** The recall plan revision when the recall closes it with no replacement. */
    recall: z.string().optional(),
    /** The published commit, so a close writes nothing after a person moved the head. */
    head: z.string().optional(),
  }),
]);

/**
 * One write as its intent records it. A create learns the number of the part below at run, and a
 * close learns the number of the first part that replaces it.
 */
export type StoredEffect = z.infer<typeof effectSchema>;

export function storedEffect(intent: string): StoredEffect {
  return readStored("publish effect", effectSchema, intent);
}

export function publicationsOf(db: CrewReader, sourceId: string): PublicationRow[] {
  return db
    .select()
    .from(stackPublications)
    .where(eq(stackPublications.sourceId, sourceId))
    .orderBy(asc(stackPublications.number))
    .all();
}

/** The pull requests of one publication, lowest part first. */
export function pullsOf(db: CrewReader, publicationId: string): PullRow[] {
  return db
    .select()
    .from(stackPullRequests)
    .where(eq(stackPullRequests.publicationId, publicationId))
    .orderBy(asc(stackPullRequests.part))
    .all();
}

/** A pull request that its create wrote, so GitHub gave it a number. */
export type WrittenPull = PullRow & { number: number };

function isWritten(pull: PullRow): pull is WrittenPull {
  return pull.number !== null;
}

/** The pull requests of one publication once every create is done, or null before then. */
export function writtenPullsOf(db: CrewReader, publicationId: string): WrittenPull[] | null {
  const pulls = pullsOf(db, publicationId);
  return pulls.every(isWritten) ? pulls : null;
}

/** The writes of one publication, in the order they run. */
export function effectsOf(db: CrewReader, publicationId: string): EffectRow[] {
  return db
    .select()
    .from(publishEffects)
    .where(eq(publishEffects.publicationId, publicationId))
    .orderBy(asc(publishEffects.position))
    .all();
}

/** Records each write as an intent after the last write of one publication, before it runs. */
export function appendEffects(
  db: CrewWriter,
  request: { publicationId: string; effects: StoredEffect[]; now: string },
): void {
  const start = effectsOf(db, request.publicationId).length;
  request.effects.forEach((effect, index) => {
    db.insert(publishEffects)
      .values({
        id: crypto.randomUUID(),
        publicationId: request.publicationId,
        position: start + index,
        kind: effect.kind,
        intent: JSON.stringify(effect),
        state: "intended",
        outcome: null,
        createdAt: request.now,
        settledAt: null,
      })
      .run();
  });
}

/** The latest reading of one part of one publication, or null before the first read. */
export function latestObservationOf(
  db: CrewReader,
  publicationId: string,
  part: number,
): ObservationRow | null {
  const row = db
    .select()
    .from(stackObservations)
    .where(
      and(eq(stackObservations.publicationId, publicationId), eq(stackObservations.part, part)),
    )
    .orderBy(desc(stackObservations.observedAt))
    .all()[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    fault: row.fault === null ? null : readStoredValue("stack fault", stackFaultSchema, row.fault),
  };
}

/** The repository of one source, which names its pull requests in an approval target. */
export function repositoryOf(db: CrewReader, sourceId: string): string {
  const source = db.select().from(workSources).where(eq(workSources.id, sourceId)).all()[0];
  return source?.trackerLocation == null
    ? sourceId
    : storedTrackerLocation(source.trackerLocation).repository;
}
