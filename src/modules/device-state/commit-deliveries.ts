import { and, desc, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Err, Ok, type Result } from "unthrown";
import type { Refusal } from "../../lib/cli-result.ts";
import { checkHistory, transaction, type Db } from "./database.ts";
import { assignments, commitDeliveries, launches, obligations, sources } from "./schema.ts";
import { recordKindHandoff } from "./kind-handoff-record.ts";
import { ownerGone } from "./leases.ts";
import { abandonConversations } from "./sources.ts";
import { decideCommitDelivery } from "./commit-delivery-machine.ts";
import { CommitReview } from "../commit-review/main.ts";

const oid = z.string().regex(/^[a-f0-9]{40,64}$/);
const finding = z.object({
  axis: z.enum(["Spec", "Standards", "Skills"]),
  severity: z.enum(["blocker", "nice-to-have"]),
  location: z.string().min(1),
  claim: z.string().min(1),
});
const deliveryRecord = z.strictObject({
  repository: z.string(),
  ticket: z.string().min(1),
  checkout: z.string(),
  localRef: z.literal("refs/heads/main"),
  remoteRef: z.literal("refs/heads/main"),
  remote: z.string().min(1),
  base: oid,
  publishedHead: oid.nullable(),
  policy: z.strictObject({
    checks: z.array(z.tuple([z.string().min(1)]).rest(z.string().min(1))).min(1),
    review: z.literal("required"),
    publication: z.literal("local-and-origin"),
  }),
  candidate: z
    .object({
      path: z.string(),
      branch: z.string(),
      tree: oid,
      head: oid.nullable(),
    })
    .nullable(),
  history: z.array(oid),
  implementer: z.string().nullable(),
  rounds: z.array(z.object({ head: oid, tree: oid, findings: z.array(finding) })).max(2),
  dispositions: z.array(
    z.object({
      round: z.number().int().positive(),
      finding: z.number().int().positive(),
      disposition: z.enum(["applied", "declined"]),
      reason: z.string().trim().min(1).optional(),
    }),
  ),
  checks: z
    .object({
      candidate: oid,
      base: oid,
      tree: oid,
      policy: z.string(),
      results: z.array(z.object({ argv: z.array(z.string()), exitCode: z.number() })),
    })
    .nullable(),
  // Intent and observation are separate receipts. No stage promises cross-system atomicity.
  journal: z.array(
    z.object({ effect: z.string(), state: z.enum(["intent", "verified"]), at: z.string() }),
  ),
  stage: z.enum(["build", "review", "checkout", "local", "remote", "finalize", "complete"]),
  ownerPid: z.number().nullable(),
  leaseAt: z.string().nullable(),
});
type Data = z.infer<typeof deliveryRecord>;

function reviewed(data: Data, candidate: NonNullable<Data["candidate"]>) {
  const latest = data.rounds.at(-1);
  if (latest === undefined) return false;
  return (
    latest.tree === candidate.tree &&
    CommitReview.decide(data.rounds, data.dispositions, candidate.head) === null
  );
}

function checked(data: Data, candidate: NonNullable<Data["candidate"]>) {
  const checks = data.checks;
  return (
    checks !== null &&
    checks.candidate === candidate.head &&
    checks.tree === candidate.tree &&
    checks.base === data.base &&
    checks.policy === JSON.stringify(data.policy) &&
    checks.results.length === data.policy.checks.length &&
    checks.results.every(
      (row, index) =>
        row.exitCode === 0 &&
        JSON.stringify(row.argv) === JSON.stringify(data.policy.checks[index]),
    )
  );
}

function evidenceValid(data: Data) {
  if (data.stage === "build") return true;
  const candidate = data.candidate;
  if (data.implementer === null || candidate === null) return false;
  if (data.stage === "review") return true;
  if (!data.history.some((head) => head === candidate.head)) return false;
  if (!reviewed(data, candidate) || !checked(data, candidate)) return false;
  if (data.stage !== "complete") return true;
  const effects = [
    "candidate_creation",
    "checkout_index",
    "local_ref",
    "remote_publication",
    "database_finalization",
  ];
  return (
    data.publishedHead !== null &&
    effects.every((effect) =>
      data.journal.some((row) => row.effect === effect && row.state === "verified"),
    )
  );
}

export const commitDeliverySchema = deliveryRecord.refine(
  evidenceValid,
  "Commit completion needs exact-candidate review, checks and verified delivery evidence.",
);

type Target = { sourceId: string; assignment: string };
type Change = {
  revision: number | null;
  data: string;
  launchId?: string;
  handoff?: string;
  complete?: boolean;
};

function workerGuard(
  db: Db,
  target: Target,
  launchId: string | undefined,
): Result<undefined, Refusal> {
  if (launchId === undefined) return Ok(undefined);
  const latest = db
    .select()
    .from(launches)
    .where(and(eq(launches.sourceId, target.sourceId), eq(launches.assignment, target.assignment)))
    .orderBy(desc(launches.attempt))
    .get();
  return latest?.id === launchId && latest.state === "running"
    ? Ok(undefined)
    : Err({
        reason: "commit_owner_inactive",
        detail: "Only the current running commit worker may write.",
        next: { command: "operator next", why: "Recover the recorded worker." },
      });
}

function deliveryGuard(
  db: Db,
  target: Target,
  previous: z.infer<typeof commitDeliverySchema> | null,
  data: z.infer<typeof commitDeliverySchema>,
): Result<undefined, Refusal> {
  if (
    previous !== null &&
    JSON.stringify([
      previous.repository,
      previous.checkout,
      previous.ticket,
      previous.base,
      previous.remote,
      previous.policy,
    ]) !==
      JSON.stringify([
        data.repository,
        data.checkout,
        data.ticket,
        data.base,
        data.remote,
        data.policy,
      ])
  )
    return Err({
      reason: "commit_target_changed",
      detail: "The assignment's target and delivery policy are immutable.",
      next: {
        command: "operator next",
        why: "Recover the pinned assignment instead of changing its target.",
      },
    });
  if (previous !== null && previous.ownerPid !== process.pid && !ownerGone(previous, Date.now()))
    return Err({
      reason: "commit_delivery_running",
      detail: "Another process holds the pinned commit candidate.",
      next: { command: "operator next --wait", why: "Wait for the current delivery process." },
    });
  const held = db
    .select()
    .from(obligations)
    .where(
      and(
        eq(obligations.sourceId, target.sourceId),
        eq(obligations.kind, "merge-hold"),
        eq(obligations.state, "open"),
      ),
    )
    .get();
  return previous?.stage === "review" && data.stage === "checkout" && held !== undefined
    ? Err({
        reason: "commit_merge_held",
        detail: "A source merge hold prevents new commit delivery.",
        next: { decider: "person", question: "Should the merge hold be released?" },
      })
    : Ok(undefined);
}

function reserveHandoff(db: Db, target: Target, change: Change) {
  if (change.handoff === undefined) return Ok(undefined);
  if (change.launchId === undefined)
    return Err({
      reason: "commit_owner_inactive",
      detail: "Only the current running commit worker may write.",
      next: { command: "operator next", why: "Recover the recorded worker." },
    });
  return recordKindHandoff(db, { ...target, launchId: change.launchId }, change.handoff);
}

/** Only the current commit worker can change evidence; a revision guards concurrent processes. */
export function changeCommitDelivery(client: Database, target: Target, change: Change) {
  return transaction(client, true, () =>
    checkHistory(client).flatMap((db): Result<number, Refusal> => {
      const key = and(
        eq(commitDeliveries.sourceId, target.sourceId),
        eq(commitDeliveries.assignment, target.assignment),
      );
      const current = db.select().from(commitDeliveries).where(key).get();
      const assignment = db
        .select()
        .from(assignments)
        .where(
          and(eq(assignments.sourceId, target.sourceId), eq(assignments.key, target.assignment)),
        )
        .get();
      const source = db.select().from(sources).where(eq(sources.id, target.sourceId)).get();
      if (
        source?.state !== "open" ||
        assignment?.completion !== "commit" ||
        (current?.revision ?? null) !== change.revision
      )
        return Err({
          reason: "commit_state_changed",
          detail: "Commit assignment or revision changed. No evidence was replaced.",
          next: { command: "operator next", why: "Read current commit-delivery evidence." },
        });
      const worker = workerGuard(db, target, change.launchId);
      if (worker.tag !== "Ok") return worker.as(0);
      const data = commitDeliverySchema.parse(JSON.parse(change.data));
      if ((change.complete === true) !== (data.stage === "complete"))
        return Err({
          reason: "commit_state_changed",
          detail: "Finalization must update evidence and assignment completion together.",
          next: { command: "operator next", why: "Recover the recorded finalization." },
        });
      const previous =
        current === undefined ? null : commitDeliverySchema.parse(JSON.parse(current.data));
      const guarded = deliveryGuard(db, target, previous, data);
      if (guarded.tag !== "Ok") return guarded.as(0);
      if (!decideCommitDelivery(previous, data))
        return Err({
          reason: "commit_transition_invalid",
          detail: "Commit delivery cannot move backward, skip stages, or remove pinned evidence.",
          next: { command: "operator next", why: "Recover the retained commit-delivery evidence." },
        });
      const handoff = reserveHandoff(db, target, change);
      return handoff.map(() => {
        const revision = (change.revision ?? 0) + 1;
        db.insert(commitDeliveries)
          .values({ ...target, revision, data: change.data })
          .onConflictDoUpdate({
            target: [commitDeliveries.sourceId, commitDeliveries.assignment],
            set: { revision, data: change.data },
          })
          .run();
        if (change.complete) {
          abandonConversations(db, target.sourceId, [target.assignment]);
          db.update(assignments)
            .set({ state: "completed" })
            .where(
              and(
                eq(assignments.sourceId, target.sourceId),
                eq(assignments.key, target.assignment),
              ),
            )
            .run();
          const rows = db
            .select()
            .from(assignments)
            .where(eq(assignments.sourceId, target.sourceId))
            .all();
          const finished = rows.every(
            (row) => row.state === (row.completion === "pr" ? "merged" : "completed"),
          );
          db.update(sources)
            .set({
              state: finished ? "finished" : "open",
              endedAt: finished ? new Date().toISOString() : null,
            })
            .where(eq(sources.id, target.sourceId))
            .run();
        }
        return revision;
      });
    }),
  );
}
