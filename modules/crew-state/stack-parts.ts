import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { PullRequestStack } from "../pull-request-stack/main.ts";
import type { ApprovalCheck } from "./approval-input.ts";
import { matchApproval } from "./approvals.ts";
import type { CrewReader } from "./database.ts";
import { identityOf } from "./identity.ts";
import { currentLandingOf, landedOfSource } from "./landing-record.ts";
import {
  assignments,
  integrationBranches,
  invalidations,
  publishEffects,
  stackObservations,
  stackPublications,
  stackPullRequests,
  workSources,
} from "./schema.ts";
import { readStored } from "./stored.ts";
import { defectInputSchema } from "./rework-input.ts";
import { storedTrackerBinding, storedTrackerLocation } from "./work-input.ts";

/**
 * The approval action by which a person settles what GitHub shows and Operator adopts nothing
 * from: a stack fault (decision 21), or a conflict that a write on an existing pull request
 * found. Only the person says that it stands as GitHub shows it.
 */
export const STACK_FAULT_ACTION = "stack-fault";

/** The approval action that covers one recall (ADR 0022, decision 23). */
export const RECALL_ACTION = "stack-recall";

type RecallCause = Parameters<typeof PullRequestStack.recallComment>[0]["causes"][number];
type ApprovalRequest = ApprovalCheck;
type PublicationRow = typeof stackPublications.$inferSelect;
type PullRow = typeof stackPullRequests.$inferSelect;
type EffectRow = typeof publishEffects.$inferSelect;

/**
 * Where one published pull request stands for a change after publish. `recalled` is a draft that
 * a recall marked, `closed` ended with no merge, and only `open` and `merged` guard their range:
 * a published commit is never rewritten in place while people still read it or after it merged.
 */
export type PartStatus = "open" | "recalled" | "closed" | "merged";

function publicationsOf(db: CrewReader, sourceId: string): PublicationRow[] {
  return db
    .select()
    .from(stackPublications)
    .where(eq(stackPublications.sourceId, sourceId))
    .orderBy(asc(stackPublications.number))
    .all();
}

function pullsOf(db: CrewReader, publicationId: string): PullRow[] {
  return db
    .select()
    .from(stackPullRequests)
    .where(eq(stackPullRequests.publicationId, publicationId))
    .orderBy(asc(stackPullRequests.part))
    .all();
}

function effectRowsOf(db: CrewReader, publicationId: string): EffectRow[] {
  return db
    .select()
    .from(publishEffects)
    .where(eq(publishEffects.publicationId, publicationId))
    .orderBy(asc(publishEffects.position))
    .all();
}

const numbered = z.looseObject({ number: z.int() });

/** The pull request numbers one kind of write of one publication reached, with its outcome done. */
function doneOn(db: CrewReader, publicationId: string, kind: "recall" | "close"): Set<number> {
  return new Set(
    effectRowsOf(db, publicationId)
      .filter((one) => one.kind === kind && one.state === "done")
      .map((one) => readStored("pull request write", numbered, one.intent).number),
  );
}

function latestSeen(db: CrewReader, publicationId: string, part: number) {
  return (
    db
      .select()
      .from(stackObservations)
      .where(
        and(eq(stackObservations.publicationId, publicationId), eq(stackObservations.part, part)),
      )
      .orderBy(desc(stackObservations.observedAt))
      .all()[0] ?? null
  );
}

/** The status of each part of one publication, from its writes and the last readings. */
export function partStatusesOf(
  db: CrewReader,
  publication: PublicationRow,
): Map<number, PartStatus> {
  const recalled = doneOn(db, publication.id, "recall");
  const closed = doneOn(db, publication.id, "close");
  return new Map(
    pullsOf(db, publication.id).map((pull) => {
      const seen = latestSeen(db, publication.id, pull.part);
      const number = pull.number ?? -1;
      const status: PartStatus =
        seen?.state === "merged"
          ? "merged"
          : closed.has(number) || seen?.state === "closed"
            ? "closed"
            : recalled.has(number)
              ? "recalled"
              : "open";
      return [pull.part, status];
    }),
  );
}

/**
 * The commits each part of one publication carries, oldest first, read from the recorded
 * landings with no Git read: the chain from the published head down to the base, cut at the
 * published commit of each part. A commit that a rewrite replaced since is no longer recorded,
 * so a recalled range that was rebuilt carries nothing here.
 */
export function commitsByPart(db: CrewReader, publication: PublicationRow): Map<number, string[]> {
  const parentOf = new Map(
    landedOfSource(db, publication.sourceId).map((one) => [one.landedCommit, one.landedParent]),
  );
  const pulls = pullsOf(db, publication.id);
  const ends = new Map(pulls.map((one) => [one.publishedCommit, one.part]));
  const found = new Map<number, string[]>();
  let part = pulls.at(-1)?.part ?? 1;
  let commit: string | undefined = publication.headCommit;
  while (commit !== undefined && commit !== publication.baseCommit) {
    part = ends.get(commit) ?? part;
    found.set(part, [commit, ...(found.get(part) ?? [])]);
    commit = parentOf.get(commit);
  }
  return found;
}

/** How one item is named in a recall: the ticket it closes and its title. */
function itemOf(row: typeof assignments.$inferSelect): string {
  if (row.trackerBinding === null) {
    return `"${row.title}"`;
  }
  const bound = storedTrackerBinding(row.trackerBinding);
  return `${bound.repository}#${bound.issue} ("${row.title}")`;
}

/**
 * One commit on the branch that must change after publish, with the record that says why: the
 * landed commit of an open invalidation, or of a withdrawn item that a take-out still removes.
 */
export type HeldCommit = { assignmentId: string; commit: string; cause: RecallCause };

export function heldCommitsOf(db: CrewReader, sourceId: string): HeldCommit[] {
  const rows = db.select().from(assignments).where(eq(assignments.sourceId, sourceId)).all();
  return rows.flatMap((row): HeldCommit[] => {
    const landing = currentLandingOf(db, row.id);
    if (landing === null) {
      return [];
    }
    if (row.state === "withdrawn") {
      return [
        {
          assignmentId: row.id,
          commit: landing.landedCommit,
          cause: { kind: "withdrawal", item: itemOf(row), planRevision: row.withdrawnUnder ?? "" },
        },
      ];
    }
    const open = db
      .select()
      .from(invalidations)
      .where(and(eq(invalidations.assignmentId, row.id), eq(invalidations.state, "open")))
      .all()[0];
    if (open === undefined) {
      return [];
    }
    const defect = readStored("defect", defectInputSchema, open.defect);
    return [
      {
        assignmentId: row.id,
        commit: landing.landedCommit,
        cause: { kind: "defect", item: itemOf(row), ...defect },
      },
    ];
  });
}

/** The commits of the integration branch of one source from its tip down, newest first. */
function branchChain(db: CrewReader, sourceId: string): { chain: string[]; base: string } | null {
  const branch = db
    .select()
    .from(integrationBranches)
    .where(eq(integrationBranches.sourceId, sourceId))
    .all()[0];
  if (branch === undefined) {
    return null;
  }
  const parentOf = new Map(
    landedOfSource(db, sourceId).map((one) => [one.landedCommit, one.landedParent]),
  );
  const chain: string[] = [];
  let commit: string | undefined = branch.recordedTip;
  while (commit !== undefined && commit !== branch.baseCommit && !chain.includes(commit)) {
    chain.push(commit);
    commit = parentOf.get(commit);
  }
  return { chain, base: branch.baseCommit };
}

/** A part of one publication, with its number and the published head of its range. */
export type PublishedPart = { publication: PublicationRow; pull: PullRow; status: PartStatus };

function partsOfSource(db: CrewReader, sourceId: string): PublishedPart[] {
  return publicationsOf(db, sourceId).flatMap((publication) => {
    const statuses = partStatusesOf(db, publication);
    return pullsOf(db, publication.id).map((pull) => ({
      publication,
      pull,
      status: statuses.get(pull.part) ?? "open",
    }));
  });
}

/**
 * The published ranges a rewrite or a take-out must not change, lowest first: each part that
 * people still read or that merged (ADR 0020). A recalled or a closed part no longer guards its
 * range, so the change runs after the recall (decision 23).
 */
export function guardedRangesOf(
  db: CrewReader,
  sourceId: string,
): Array<{ head: string; pullRequest: number | null; url: string | null }> {
  return partsOfSource(db, sourceId)
    .filter((one) => one.status === "open" || one.status === "merged")
    .map((one) => ({
      head: one.pull.publishedCommit,
      pullRequest: one.pull.number,
      url: one.pull.url,
    }));
}

/** The part of a published pull request that carries one commit, if a publication holds it. */
export function partOfCommit(
  db: CrewReader,
  sourceId: string,
  commit: string,
): PublishedPart | null {
  for (const one of partsOfSource(db, sourceId)) {
    if ((commitsByPart(db, one.publication).get(one.pull.part) ?? []).includes(commit)) {
      return one;
    }
  }
  return null;
}

export type RecallDue = {
  publication: PublicationRow;
  repository: string;
  /** Each open pull request from the affected part up, bottom up. The parts below stay open. */
  parts: Array<{ part: number; number: number; head: string }>;
  causes: RecallCause[];
  /**
   * False when every code item above the recalled point is withdrawn and no item can still
   * land, so no new publication will close them: the recall then closes them too (decision 30).
   */
  replaced: boolean;
};

/** A part that merged while it held a commit that has to change: a merge before the recall. */
export type MergedHeld = {
  publication: PublicationRow;
  part: number;
  number: number;
  causes: RecallCause[];
};

function repositoryOf(db: CrewReader, sourceId: string): string {
  const source = db.select().from(workSources).where(eq(workSources.id, sourceId)).all()[0];
  return source?.trackerLocation == null
    ? sourceId
    : storedTrackerLocation(source.trackerLocation).repository;
}

const OPEN_WORK = new Set(["accepted", "withdrawn"]);

/** Whether a new publication will carry work above the recalled point (decision 30). */
function replacedAbove(
  db: CrewReader,
  sourceId: string,
  publication: PublicationRow,
  lowest: number,
): boolean {
  const rows = db.select().from(assignments).where(eq(assignments.sourceId, sourceId)).all();
  if (rows.some((row) => row.kind === "production" && !OPEN_WORK.has(row.state))) {
    return true;
  }
  const below = pullsOf(db, publication.id).find((one) => one.part === lowest - 1);
  const stop = below?.publishedCommit ?? publication.baseCommit;
  const chain = branchChain(db, sourceId)?.chain ?? [];
  const above = chain.slice(0, chain.includes(stop) ? chain.indexOf(stop) : chain.length);
  const withdrawn = new Set(rows.filter((row) => row.state === "withdrawn").map((row) => row.id));
  return landedOfSource(db, sourceId).some(
    (one) => above.includes(one.landedCommit) && !withdrawn.has(one.assignmentId),
  );
}

/**
 * What a change after publish asks of the published stack of one source, read from the records
 * only, so `crew next` can offer it: the recall of each open pull request from the lowest part
 * that holds a commit to change, and each part that merged before any recall (decisions 23, 24).
 */
export function recallOf(
  db: CrewReader,
  sourceId: string,
): { due: RecallDue | null; merged: MergedHeld[] } {
  const held = heldCommitsOf(db, sourceId);
  const merged: MergedHeld[] = [];
  let due: RecallDue | null = null;
  if (held.length === 0) {
    return { due, merged };
  }
  for (const publication of publicationsOf(db, sourceId)) {
    const statuses = partStatusesOf(db, publication);
    const byPart = commitsByPart(db, publication);
    const pulls = pullsOf(db, publication.id);
    const touched = pulls.flatMap((pull) => {
      const causes = held
        .filter((one) => (byPart.get(pull.part) ?? []).includes(one.commit))
        .map((one) => one.cause);
      return causes.length === 0 ? [] : [{ pull, causes, status: statuses.get(pull.part) }];
    });
    for (const one of touched.filter((touch) => touch.status === "merged")) {
      merged.push({
        publication,
        part: one.pull.part,
        number: one.pull.number ?? 0,
        causes: one.causes,
      });
    }
    const lowest = touched.find((touch) => touch.status === "open");
    if (due !== null || lowest === undefined) {
      continue;
    }
    const parts = pulls
      .filter(
        (pull) =>
          pull.part >= lowest.pull.part &&
          statuses.get(pull.part) === "open" &&
          pull.number !== null,
      )
      .map((pull) => ({ part: pull.part, number: pull.number ?? 0, head: pull.publishedCommit }));
    const recalled = new Set(parts.map((one) => one.part));
    due = {
      publication,
      repository: repositoryOf(db, sourceId),
      parts,
      causes: touched
        .filter((touch) => recalled.has(touch.pull.part))
        .flatMap((touch) => touch.causes),
      replaced: replacedAbove(db, sourceId, publication, lowest.pull.part),
    };
  }
  return { due, merged };
}

/**
 * Where the next stack publication of one source starts (decision 23). The last publication
 * keeps each part below its lowest part that a recall, a close, or a fault ended; the parts above
 * that one are replaced. A kept part must merge first, so the new publication starts on its
 * published commit and its lowest part targets the target branch. With no publication, or a base
 * the branch no longer holds after a rebase, it starts on the integration base.
 */
export function publishBaseOf(
  db: CrewReader,
  sourceId: string,
): {
  /** The commit the new publication starts on, or null for the integration base. */
  base: string | null;
  replaces: Array<{ number: number; url: string | null; head: string }>;
  /** Each kept part that has not merged, which the new publication waits for. */
  waiting: Array<{ publication: number; part: number; number: number }>;
  /** True when the last publication holds a part that a new publication replaces. */
  superseded: boolean;
  /** Each fault of the last publication that no person settled, which holds a new one. */
  unsettled: Fault[];
} {
  const publication = publicationsOf(db, sourceId).at(-1);
  const pulls = publication === undefined ? [] : pullsOf(db, publication.id);
  if (publication === undefined || pulls.some((one) => one.number === null)) {
    return { base: null, replaces: [], waiting: [], superseded: false, unsettled: [] };
  }
  const statuses = partStatusesOf(db, publication);
  const faults = faultsOf(db, publication);
  // The lowest part a new publication replaces: a recalled or closed part, a part with a settled
  // fault that ended it, or the part above a settled merge by another method, which stays merged.
  const firstFault = faults[0];
  const lowest = Math.min(
    pulls.find((one) => {
      const status = statuses.get(one.part);
      return status === "recalled" || status === "closed";
    })?.part ?? Number.POSITIVE_INFINITY,
    firstFault === undefined || !firstFault.settled
      ? Number.POSITIVE_INFINITY
      : firstFault.fault === "not_merge_commit"
        ? firstFault.part + 1
        : firstFault.part,
  );
  const kept = pulls.filter((one) => one.part < lowest);
  const replaces = pulls
    .filter(
      (one) =>
        one.part >= lowest &&
        (statuses.get(one.part) === "recalled" || statuses.get(one.part) === "open"),
    )
    .map((one) => ({ number: one.number ?? 0, url: one.url, head: one.publishedCommit }));
  const candidate = kept.at(-1)?.publishedCommit ?? publication.baseCommit;
  const branch = branchChain(db, sourceId);
  const onBranch =
    branch !== null && (branch.chain.includes(candidate) || branch.base === candidate);
  return {
    base: onBranch && candidate !== branch?.base ? candidate : null,
    replaces,
    waiting: kept
      .filter((one) => statuses.get(one.part) !== "merged")
      .map((one) => ({ publication: publication.number, part: one.part, number: one.number ?? 0 })),
    superseded: Number.isFinite(lowest),
    unsettled: faults.filter((one) => !one.settled),
  };
}

/** The pull request a write on an existing pull request names, or null for a push or a create. */
function pullTargetOf(effect: EffectRow): number | null {
  return effect.kind === "retarget" || effect.kind === "recall" || effect.kind === "close"
    ? readStored("pull request write", numbered, effect.intent).number
    : null;
}

/**
 * The approval that settles one conflict a write on an existing pull request found (#120): a
 * retarget, a recall, or a close. Its revision is the conflict as recorded, so another conflict
 * needs a new settlement. A push or a create has none: what it found was never planned, and a
 * person settles it outside Operator.
 */
export function conflictSettlementOf(
  db: CrewReader,
  sourceId: string,
  effect: EffectRow,
): ApprovalRequest | null {
  const number = pullTargetOf(effect);
  if (effect.state !== "conflict" || number === null) {
    return null;
  }
  return {
    action: STACK_FAULT_ACTION,
    targets: [`${repositoryOf(db, sourceId)}#${number}`],
    scope: sourceId,
    requestRevision: identityOf({ effectId: effect.id, outcome: effect.outcome }),
  };
}

/** True when a person settled the conflict one write found, so nothing repeats it. */
export function conflictSettled(db: CrewReader, sourceId: string, effect: EffectRow): boolean {
  const settlement = conflictSettlementOf(db, sourceId, effect);
  return settlement !== null && matchApproval(db, settlement).status === "matched";
}

type ObservationRow = typeof stackObservations.$inferSelect;

/**
 * The approval that settles one fault as one reading recorded it. Its revision is that reading,
 * so a different fault, a moved head, or another merge needs a new settlement.
 */
function faultSettlementOf(
  db: CrewReader,
  publication: PublicationRow,
  seen: ObservationRow,
  fault: string,
): ApprovalRequest {
  return {
    action: STACK_FAULT_ACTION,
    targets: [`${repositoryOf(db, publication.sourceId)}#${seen.number}`],
    scope: publication.sourceId,
    requestRevision: identityOf({
      publicationId: publication.id,
      part: seen.part,
      fault,
      head: seen.headCommit,
      base: seen.base,
      mergeCommit: seen.mergeCommit,
    }),
  };
}

export type Fault = {
  part: number;
  number: number;
  fault: string;
  detail: string;
  settlement: ApprovalRequest;
  settled: boolean;
};

function causeText(cause: RecallCause): string {
  return cause.kind === "defect"
    ? `the open defect of ${cause.item}`
    : `the withdrawn item ${cause.item}, whose issue its closing keyword may have closed`;
}

/**
 * Each fault of one publication, lowest part first: what the last reading of a part showed, and
 * a merge of a part that held a commit to change before any recall (decision 24). A merged
 * commit is never invalidated or taken out, so that fault waits on a person, and the defect or
 * the unwanted change becomes a new issue.
 */
export function faultsOf(db: CrewReader, publication: PublicationRow): Fault[] {
  const merged = recallOf(db, publication.sourceId).merged.filter(
    (one) => one.publication.id === publication.id,
  );
  return pullsOf(db, publication.id).flatMap((pull): Fault[] => {
    const seen = latestSeen(db, publication.id, pull.part);
    if (seen === null) {
      return [];
    }
    const held = merged.find((one) => one.part === pull.part);
    const fault = seen.fault ?? (held === undefined ? null : ("merged_before_recall" as const));
    if (fault === null) {
      return [];
    }
    const settlement = faultSettlementOf(db, publication, seen, fault);
    return [
      {
        part: pull.part,
        number: pull.number ?? 0,
        fault,
        detail:
          seen.fault !== null || held === undefined
            ? (seen.detail ?? "")
            : `It merged before a recall, while it held ${held.causes.map(causeText).join(" and ")}. A merged commit is never changed, so the change becomes a new issue.`,
        settlement,
        settled: matchApproval(db, settlement).status === "matched",
      },
    ];
  });
}
