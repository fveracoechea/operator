import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { HerdrControl } from "../herdr-control/main.ts";
import { PullRequestStack } from "../pull-request-stack/main.ts";
import { approvalCovers, readApproval } from "./approvals.ts";
import { readAssignment } from "./assignment.ts";
import type { CrewReader } from "./database.ts";
import { checkoutOf, runningRunOf } from "./gate-runs.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  effectsOf,
  PUBLISH_ACTION,
  publicationsOf,
  pullRequestsOf,
  trackerStepTarget,
} from "./publish.ts";
import {
  assignments,
  gateCheckouts,
  stackObservations,
  stackPublications,
  workSources,
} from "./schema.ts";
import { readStored } from "./stored.ts";
import { latestSubmission, submittedCommit } from "./submission.ts";
import { readBinding, TRACKER_STEPS, targetOf, trackerOperationFor } from "./tracker.ts";
import { storedTrackerBinding, storedTrackerLocation } from "./work-input.ts";

type PublicationRow = typeof stackPublications.$inferSelect;
type ObservationRow = typeof stackObservations.$inferSelect;
type Observed = Extract<Awaited<ReturnType<typeof PullRequestStack.observe>>, { status: "read" }>;
type Seen = Observed["seen"][number];

const basis = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("approved-scope") }),
  z.strictObject({
    kind: z.literal("requirement"),
    position: z.int(),
    text: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal("question"), questionId: z.string() }),
]);

const trackerStepsSchema = z.array(
  z.strictObject({
    part: z.int(),
    commit: z.string(),
    closes: z.string(),
    resolution: z.string(),
    behaviorChanges: z.array(z.strictObject({ statement: z.string(), basis })),
  }),
);

/** The tracker steps after the merge that one publication's approval names (D2). */
export function trackerStepsOf(publication: PublicationRow) {
  return readStored("publication tracker steps", trackerStepsSchema, publication.trackerSteps);
}

/** The latest reading of one part of one publication, or null before the first read. */
export function latestObservationOf(
  db: CrewReader,
  publicationId: string,
  part: number,
): ObservationRow | null {
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

/** A part reached the target with its commits, so the tracker steps of its items may run. */
function reachedTarget(seen: ObservationRow | null): boolean {
  return (
    seen !== null &&
    seen.state === "merged" &&
    (seen.fault === null || seen.fault === "not_merge_commit")
  );
}

/** The publication whose approval names the tracker steps of one ticket, newest first. */
function publicationOfTicket(db: CrewReader, sourceId: string, closes: string) {
  for (const publication of publicationsOf(db, sourceId).toReversed()) {
    const step = trackerStepsOf(publication).find((one) => one.closes === closes);
    if (step !== undefined) {
      return { publication, step };
    }
  }
  return null;
}

export type MergeGate =
  | { status: "not-code" }
  | { status: "waiting"; detail: string }
  | {
      status: "merged";
      /** The resolution, rendered from the recorded merge with no free text (decision 18). */
      resolution: string;
      /**
       * Whether the publish approval still names each step with this text (D2). The map
       * amendment also waits for a second approval of its own text.
       */
      approved: { resolution: boolean; completion: boolean; map_amendment: boolean };
      approvalId: string;
    };

/**
 * Whether the tracker steps of one assignment may run. The steps of a code result run only after
 * the pull request that carries its commit merged into the target, as `operator publish status`
 * recorded it (ADR 0022). Any other result keeps the steps it had.
 */
export function mergeGateOf(db: CrewReader, assignmentId: string): MergeGate {
  const assignment = readAssignment(db, assignmentId);
  const submission = latestSubmission(db, assignmentId);
  if (
    assignment === null ||
    assignment.kind !== "production" ||
    submission === null ||
    submittedCommit(submission) === null
  ) {
    return { status: "not-code" };
  }
  const bound = readBinding(db, assignmentId);
  if (bound.status !== "bound") {
    return { status: "not-code" };
  }
  const closes = `${bound.binding.repository}#${bound.binding.issue}`;
  const found = publicationOfTicket(db, assignment.sourceId, closes);
  if (found === null) {
    return {
      status: "waiting",
      detail: `No stack publication carries the commit of ${closes} yet, so no commit of it is on the target branch.`,
    };
  }
  const { publication, step } = found;
  const pull = pullRequestsOf(db, publication.id).find((one) => one.part === step.part);
  const seen = latestObservationOf(db, publication.id, step.part);
  if (pull?.number == null || !reachedTarget(seen) || seen === null) {
    return {
      status: "waiting",
      detail:
        seen === null
          ? `No merge of the pull request of ${closes} is recorded. Run \`operator publish status --source ${assignment.sourceId}\` when the user reports a merge.`
          : `The pull request of ${closes} is ${seen.state}${seen.fault === null ? "" : ` with the stack fault ${seen.fault}`}, so its commit did not reach the target.`,
    };
  }
  const repository = closes.slice(0, closes.lastIndexOf("#"));
  const render = (pullRequest: number | null) =>
    PullRequestStack.resolution({
      repository,
      target: publication.target,
      commit: step.commit,
      behaviorChanges: step.behaviorChanges,
      pullRequest,
      landed:
        seen.fault === "not_merge_commit" && seen.mergeCommit !== null
          ? { commit: seen.mergeCommit, method: seen.method ?? "unknown" }
          : null,
    });
  const approval = readApproval(db, publication.approvalId);
  const targets = {
    resolution: trackerStepTarget(closes, "resolution"),
    completion: trackerStepTarget(closes, "completion"),
    map_amendment: trackerStepTarget(closes, "map_amendment"),
  };
  const covers = (target: string) =>
    approval !== null &&
    approvalCovers(approval, {
      action: PUBLISH_ACTION,
      targets: [target],
      scope: publication.sourceId,
      requestRevision: publication.planRevision,
    }).status === "covers";
  return {
    status: "merged",
    resolution: render(pull.number),
    // After a merge commit, the text is the one the approval bound with its slot filled. Another
    // method names the commit that landed, which the plan could not know.
    approved: {
      resolution:
        covers(targets.resolution) && (seen.fault !== null || render(null) === step.resolution),
      completion: covers(targets.completion),
      map_amendment: covers(targets.map_amendment),
    },
    approvalId: publication.approvalId,
  };
}

/** The last publication of one source when every write of it is done, with its pull requests. */
function writtenPublicationOf(db: CrewReader, sourceId: string) {
  const publication = publicationsOf(db, sourceId).at(-1);
  if (publication === undefined) {
    return null;
  }
  const pulls = pullRequestsOf(db, publication.id);
  const written =
    effectsOf(db, publication.id).every((one) => one.state === "done") &&
    pulls.every((one) => one.number !== null);
  return { publication, pulls, written };
}

/**
 * The state of the last publication of one source, read from the recorded observations only.
 * `crew next` reads this, so it never reads GitHub (ADR 0016).
 */
export function stackStateOf(
  db: CrewReader,
  sourceId: string,
):
  | { state: "none" }
  | { state: "unwritten" }
  | {
      state: "faulted";
      publication: number;
      faults: Array<{ part: number; number: number; fault: string; detail: string }>;
    }
  | { state: "open"; publication: number; open: number[] }
  | { state: "merged"; publication: number } {
  const last = writtenPublicationOf(db, sourceId);
  if (last === null) {
    return { state: "none" };
  }
  if (!last.written) {
    return { state: "unwritten" };
  }
  const seen = last.pulls.map((one) => ({
    pull: one,
    seen: latestObservationOf(db, last.publication.id, one.part),
  }));
  const faults = seen.flatMap((one) =>
    one.seen?.fault == null
      ? []
      : [
          {
            part: one.pull.part,
            number: one.pull.number ?? 0,
            fault: one.seen.fault,
            detail: one.seen.detail ?? "",
          },
        ],
  );
  if (faults.length > 0) {
    return { state: "faulted", publication: last.publication.number, faults };
  }
  const open = seen.filter((one) => one.seen?.state !== "merged");
  return open.length > 0
    ? {
        state: "open",
        publication: last.publication.number,
        open: open.map((one) => one.pull.number ?? 0),
      }
    : { state: "merged", publication: last.publication.number };
}

/** The assignments whose tickets one publication completes, by the ticket each one closes. */
function itemsOf(db: CrewReader, publication: PublicationRow): string[] {
  const closes = new Set(trackerStepsOf(publication).map((one) => one.closes));
  return db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, publication.sourceId))
    .all()
    .filter((row) => {
      if (row.trackerBinding === null) {
        return false;
      }
      const bound = storedTrackerBinding(row.trackerBinding);
      return closes.has(`${bound.repository}#${bound.issue}`);
    })
    .map((row) => row.id);
}

/**
 * Whether one source is finished: every pull request of its last publication merged with a
 * merge commit, and every tracker step of its items is verified (decision 29).
 */
function finishedOf(db: CrewReader, sourceId: string): { finished: boolean; detail: string } {
  const state = stackStateOf(db, sourceId);
  if (state.state !== "merged") {
    return { finished: false, detail: `The last stack publication is ${state.state}.` };
  }
  const last = writtenPublicationOf(db, sourceId);
  if (last === null) {
    return { finished: false, detail: "No stack publication is recorded." };
  }
  for (const assignmentId of itemsOf(db, last.publication)) {
    const bound = readBinding(db, assignmentId);
    if (bound.status !== "bound") {
      continue;
    }
    const owed = TRACKER_STEPS.filter(
      (step) =>
        targetOf(bound.binding, step) !== null &&
        trackerOperationFor(db, { assignmentId, step })?.state !== "verified",
    );
    if (owed.length > 0) {
      return {
        finished: false,
        detail: `Assignment ${assignmentId} still owes the tracker step(s) ${owed.join(", ")}.`,
      };
    }
  }
  return {
    finished: true,
    detail: "Every pull request merged with a merge commit and every tracker step is verified.",
  };
}

export type Finish =
  | { status: "not-finished"; detail: string }
  | { status: "finished"; gateCheckout: "removed" | "absent" | "kept"; detail: string | null };

/**
 * Ends one finished source: its gate checkout is removed by an unforced Herdr removal, with no
 * approval (decision 29). Herdr refuses a checkout that holds a change, so nothing that did not
 * land is torn down, and no branch is deleted (ADR 0010).
 */
export async function finishSource(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
}): Promise<Finish | StateFailure | RequestFailure> {
  const read = await readState(request.projectRoot, (db) => ({
    verdict: finishedOf(db, request.sourceId),
    checkout: checkoutOf(db, request.sourceId),
    running: runningRunOf(db, request.sourceId) !== null,
  }));
  if ("status" in read) {
    return read;
  }
  if (!read.verdict.finished) {
    return { status: "not-finished", detail: read.verdict.detail };
  }
  if (read.checkout === null) {
    return { status: "finished", gateCheckout: "absent", detail: null };
  }
  if (read.running) {
    return {
      status: "finished",
      gateCheckout: "kept",
      detail: "A gate run of this source still runs in its gate checkout.",
    };
  }
  const { path, workspaceId } = read.checkout;
  let found = await HerdrControl.findWorktree({ repoRoot: request.projectRoot, path });
  let detail: string | null = null;
  if (found.status === "found") {
    const removed = await HerdrControl.removeWorktree({ workspaceId });
    detail =
      removed.status === "succeeded"
        ? null
        : removed.status === "failed"
          ? `${removed.code}: ${removed.detail}`
          : removed.detail;
    found = await HerdrControl.findWorktree({ repoRoot: request.projectRoot, path });
  }
  if (found.status !== "absent") {
    return {
      status: "finished",
      gateCheckout: "kept",
      detail:
        detail ??
        (found.status === "unknown"
          ? found.detail
          : `Herdr still lists the gate checkout ${path}.`),
    };
  }
  const recorded = await mutate(
    {
      projectRoot: request.projectRoot,
      requestId: `${request.requestId}#finish`,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "gate_checkout_remove",
      input: { sourceId: request.sourceId, path },
    },
    ({ tx }) => {
      tx.delete(gateCheckouts).where(eq(gateCheckouts.sourceId, request.sourceId)).run();
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (recorded.result.status !== "recorded") {
    return recorded.result;
  }
  return { status: "finished", gateCheckout: "removed", detail: null };
}

/** Finishes the source of one assignment whose tracker step was just verified, if it is done. */
export async function finishAfterStep(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  assignmentId: string;
}): Promise<Finish | StateFailure | RequestFailure> {
  const read = await readState(request.projectRoot, (db) => ({
    assignment: readAssignment(db, request.assignmentId),
  }));
  if ("status" in read) {
    return read;
  }
  if (read.assignment === null) {
    return { status: "not-finished", detail: `No assignment ${request.assignmentId} is recorded.` };
  }
  return finishSource({ ...request, sourceId: read.assignment.sourceId });
}

export type StatusResult =
  | {
      status: "observed";
      publication: number;
      seen: Seen[];
      finish: Finish;
    }
  | { status: "nothing-published"; sourceId: string }
  | { status: "publish-unsettled"; sourceId: string; publication: number }
  | { status: "unknown-source"; sourceId: string }
  | { status: "unread"; detail: string }
  | StateFailure
  | RequestFailure;

/**
 * Reads each pull request of the last publication of one source from GitHub and records what it
 * shows: its state, head, base, merge commit, and merge method, and each stack fault. The
 * Operator runs it when the user reports a merge or a close, or asks for the state. It writes
 * nothing to GitHub, and Operator never merges (D6).
 */
export async function observePublish(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
}): Promise<StatusResult> {
  const read = await readState(request.projectRoot, (db) => ({
    source: db.select().from(workSources).where(eq(workSources.id, request.sourceId)).all()[0],
    last: writtenPublicationOf(db, request.sourceId),
  }));
  if ("status" in read) {
    return read;
  }
  if (read.source === undefined) {
    return { status: "unknown-source", sourceId: request.sourceId };
  }
  if (read.last === null) {
    return { status: "nothing-published", sourceId: request.sourceId };
  }
  const { publication, pulls, written } = read.last;
  if (!written || read.source.trackerLocation === null) {
    return {
      status: "publish-unsettled",
      sourceId: request.sourceId,
      publication: publication.number,
    };
  }
  const observed = await PullRequestStack.observe({
    repository: storedTrackerLocation(read.source.trackerLocation).repository,
    target: publication.target,
    pullRequests: pulls.map((one) => ({
      part: one.part,
      number: one.number ?? 0,
      publishedCommit: one.publishedCommit,
    })),
  });
  if (observed.status !== "read") {
    return observed;
  }
  const recorded = await mutate(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "publish_status",
      input: { sourceId: request.sourceId, seen: observed.seen },
    },
    ({ tx, now }) => {
      for (const one of observed.seen) {
        tx.insert(stackObservations)
          .values({
            id: crypto.randomUUID(),
            publicationId: publication.id,
            part: one.part,
            number: one.number,
            state: one.state,
            headCommit: one.head,
            base: one.base,
            draft: one.draft ? 1 : 0,
            mergeCommit: one.mergeCommit,
            method: one.method,
            fault: one.fault,
            detail: one.detail,
            observedAt: now,
          })
          .run();
      }
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (recorded.result.status !== "recorded") {
    return recorded.result;
  }
  const finish = await finishSource(request);
  if (finish.status !== "finished" && finish.status !== "not-finished") {
    return finish;
  }
  return { status: "observed", publication: publication.number, seen: observed.seen, finish };
}
