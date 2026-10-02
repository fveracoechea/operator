import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { HerdrControl } from "../herdr-control/main.ts";
import { PullRequestStack } from "../pull-request-stack/main.ts";
import { approvalCovers, matchApproval, readApproval } from "./approvals.ts";
import { publishRecordsOf } from "./publish-gate.ts";
import { type Fault, faultsOf, partStatusesOf, publishBaseOf } from "./stack-parts.ts";
import { readAssignment } from "./assignment.ts";
import type { CrewReader } from "./database.ts";
import { checkoutOf, runningRunOf } from "./gate-runs.ts";
import { mutate, readState, type RequestFailure, type StateFailure } from "./operations.ts";
import {
  type ApplyResult,
  applyPublish,
  planPublish,
  type ReplacedPull,
  type ApprovalRequest,
  effectsOf,
  openEffectsOf,
  PUBLISH_ACTION,
  publicationsOf,
  pullRequestsOf,
  runEffects,
  trackerStepTarget,
} from "./publish.ts";
import {
  assignments,
  gateCheckouts,
  publishEffects,
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

/**
 * Each published pull request of one source, read from the recorded observations only, for a
 * rebase (ADR 0022). A part that reached the target names its published commit and its merge
 * commit. Any other part that no read shows merged or closed is still open, also when it has a
 * stack fault, because a person can still read and merge it.
 */
export function publishedPartsOf(
  db: CrewReader,
  sourceId: string,
): {
  merged: Array<{ number: number; publishedCommit: string; mergeCommit: string }>;
  open: Array<{ number: number | null; url: string | null; fault: string | null }>;
} {
  const merged: Array<{ number: number; publishedCommit: string; mergeCommit: string }> = [];
  const open: Array<{ number: number | null; url: string | null; fault: string | null }> = [];
  for (const publication of publicationsOf(db, sourceId)) {
    for (const pull of pullRequestsOf(db, publication.id)) {
      const seen = latestObservationOf(db, publication.id, pull.part);
      if (reachedTarget(seen) && seen?.mergeCommit != null) {
        merged.push({
          number: pull.number ?? 0,
          publishedCommit: pull.publishedCommit,
          mergeCommit: seen.mergeCommit,
        });
      } else if (seen?.state !== "merged" && seen?.state !== "closed") {
        open.push({ number: pull.number, url: pull.url, fault: seen?.fault ?? null });
      }
    }
  }
  return { merged, open };
}

/**
 * The open pull requests of the last publication of one source that the next stack publication
 * replaces: each recalled part, the part a settled fault left open, and the parts above a fault,
 * which stay stopped. The next publication carries their commits, after a recall or a rebase, and
 * closes each one with a pointer to its replacement (decision 23).
 */
export function replacedPullsOf(db: CrewReader, sourceId: string): ReplacedPull[] {
  const last = writtenPublicationOf(db, sourceId);
  if (last === null || !last.written) {
    return [];
  }
  return publishBaseOf(db, sourceId).replaces;
}

/** Plans the next stack publication of one source, with the pull requests it replaces. */
export async function planStack(request: { projectRoot: string; sourceId: string }) {
  const replaces = await readState(request.projectRoot, (db) => ({
    ...replacedSplitOf(db, request.sourceId),
  }));
  return "status" in replaces
    ? replaces
    : planPublish({ ...request, replaces: replaces.pulls, headMoved: replaces.headMoved });
}

/** Applies the next stack publication of one source, with the pull requests it replaces. */
export async function applyStack(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
  planRevision: string;
}): Promise<ApplyResult> {
  const replaces = await readState(request.projectRoot, (db) => ({
    ...replacedSplitOf(db, request.sourceId),
  }));
  return "status" in replaces
    ? replaces
    : applyPublish({ ...request, replaces: replaces.pulls, headMoved: replaces.headMoved });
}

/**
 * The pull requests the next stack publication replaces, split by what it writes to them. A
 * person moved the head of a pull request with a `head_moved` fault, so Operator writes nothing
 * more to it, no comment and no close. The plan only names it (decision 21).
 */
function replacedSplitOf(
  db: CrewReader,
  sourceId: string,
): { pulls: ReplacedPull[]; headMoved: ReplacedPull[] } {
  const last = writtenPublicationOf(db, sourceId);
  const moved = new Set(
    (last?.pulls ?? [])
      .filter(
        (pull) =>
          last !== null &&
          latestObservationOf(db, last.publication.id, pull.part)?.fault === "head_moved",
      )
      .map((pull) => pull.number),
  );
  const replaced = replacedPullsOf(db, sourceId);
  return {
    pulls: replaced.filter((one) => !moved.has(one.number)),
    headMoved: replaced.filter((one) => moved.has(one.number)),
  };
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
    openEffectsOf(db, publication).length === 0 && pulls.every((one) => one.number !== null);
  return { publication, pulls, written };
}

/** The repository of one source, which names its pull requests in an approval target. */
function repositoryOf(db: CrewReader, sourceId: string): string {
  const source = db.select().from(workSources).where(eq(workSources.id, sourceId)).all()[0];
  return source?.trackerLocation == null
    ? sourceId
    : storedTrackerLocation(source.trackerLocation).repository;
}

/**
 * Each part of one written publication as the last readings show it. A fault on one part stops
 * every part above it (decision 20), so a part above the lowest fault is stopped, never due.
 */
function partsOf(db: CrewReader, publication: PublicationRow) {
  const statuses = partStatusesOf(db, publication);
  const pulls = pullRequestsOf(db, publication.id).map((pull) => ({
    pull,
    seen: latestObservationOf(db, publication.id, pull.part),
    status: statuses.get(pull.part) ?? "open",
  }));
  const faults = faultsOf(db, publication);
  const lowest = faults[0]?.part ?? Number.POSITIVE_INFINITY;
  return { pulls, faults, lowest };
}

/**
 * The state of the last publication of one source, read from the recorded observations only.
 * `crew next` reads this, so it never reads GitHub (ADR 0016). A settled fault of a merge by
 * another method counts as landed, because its commits reached the target. Any other settled
 * fault ends its part, and a part above a fault is stopped: their commits reach the target only
 * through a new stack publication. A recalled part waits for that publication too, or is closed
 * by its recall when no new publication will replace it (decisions 23 and 30).
 */
export function stackStateOf(
  db: CrewReader,
  sourceId: string,
):
  | { state: "none" }
  | { state: "unwritten" }
  | { state: "faulted"; publication: number; faults: Fault[]; stopped: number[] }
  | { state: "ended"; publication: number; ended: Fault[]; stopped: number[] }
  | { state: "open"; publication: number; open: number[] }
  | { state: "recalled"; publication: number; recalled: number[]; closed: boolean }
  | { state: "merged"; publication: number } {
  const last = writtenPublicationOf(db, sourceId);
  if (last === null) {
    return { state: "none" };
  }
  if (!last.written) {
    return { state: "unwritten" };
  }
  const { pulls, faults, lowest } = partsOf(db, last.publication);
  const publication = last.publication.number;
  const faulted = new Set(faults.map((one) => one.part));
  const stopped = pulls
    .filter((one) => one.pull.part > lowest && !faulted.has(one.pull.part) && one.status === "open")
    .map((one) => one.pull.part);
  if (faults.some((one) => !one.settled)) {
    return { state: "faulted", publication, faults: faults.filter((one) => !one.settled), stopped };
  }
  const ended = faults.filter((one) => one.fault !== "not_merge_commit");
  if (ended.length > 0 || stopped.length > 0) {
    return { state: "ended", publication, ended, stopped };
  }
  const open = pulls.filter((one) => one.status === "open" && !faulted.has(one.pull.part));
  if (open.length > 0) {
    return { state: "open", publication, open: open.map((one) => one.pull.number ?? 0) };
  }
  const recalled = pulls.filter((one) => one.status === "recalled" || one.status === "closed");
  return recalled.length > 0
    ? {
        state: "recalled",
        publication,
        recalled: recalled.map((one) => one.pull.number ?? 0),
        closed: recalled.every((one) => one.status === "closed"),
      }
    : { state: "merged", publication };
}

/** The approval of one publication that its retarget needs: its name and the target (D6). */
function retargetApprovalOf(publication: PublicationRow, headName: string): ApprovalRequest {
  return {
    action: PUBLISH_ACTION,
    targets: [headName, publication.target],
    scope: publication.sourceId,
    requestRevision: publication.planRevision,
  };
}

/** The pull request numbers one publication already has a retarget write for. */
function retargetedOf(db: CrewReader, publicationId: string): Set<number> {
  return new Set(
    effectsOf(db, publicationId)
      .filter((one) => one.kind === "retarget")
      .map((one) => readStored("retarget intent", z.looseObject({ number: z.int() }), one.intent))
      .map((one) => one.number),
  );
}

export type RetargetDue = {
  publicationId: string;
  part: number;
  number: number;
  from: string;
  target: string;
  approval: ApprovalRequest;
  approved: boolean;
};

/**
 * The parts whose base changes to the target next: the part below merged by a merge commit, no
 * part below holds a fault, and no retarget of it is recorded (decision 15). A part that holds a
 * fault itself gets no retarget either, so a pull request whose head a person moved gets no more
 * writes (decision 21). It reads only the recorded readings, so `crew next` can offer it.
 */
export function retargetsDue(db: CrewReader, sourceId: string): RetargetDue[] {
  const last = writtenPublicationOf(db, sourceId);
  if (last === null || !last.written) {
    return [];
  }
  const { pulls, lowest } = partsOf(db, last.publication);
  const retargeted = retargetedOf(db, last.publication.id);
  return pulls.flatMap(({ pull, seen }, index) => {
    const below = pulls[index - 1];
    const due =
      below !== undefined &&
      pull.part < lowest &&
      below.seen?.state === "merged" &&
      below.seen.fault === null &&
      pull.number !== null &&
      !retargeted.has(pull.number) &&
      // A recalled part, or one above a recalled part, waits for the publication that replaces it.
      pulls.slice(0, index + 1).every((one) => one.status === "open" || one.status === "merged") &&
      (seen === null || seen.state === "open");
    if (!due || pull.number === null) {
      return [];
    }
    const approval = retargetApprovalOf(last.publication, pull.headName);
    return [
      {
        publicationId: last.publication.id,
        part: pull.part,
        number: pull.number,
        from: pull.plannedBase,
        target: last.publication.target,
        approval,
        approved: matchApproval(db, approval).status === "matched",
      },
    ];
  });
}

/**
 * The assignments whose tickets the publications of one source complete, by the ticket each one
 * closes. A withdrawn item completes nothing: Operator writes nothing to the tracker for it.
 */
function itemsOf(db: CrewReader, sourceId: string): string[] {
  const closes = new Set(
    publicationsOf(db, sourceId).flatMap((one) => trackerStepsOf(one).map((step) => step.closes)),
  );
  return db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, sourceId))
    .all()
    .filter((row) => {
      if (row.trackerBinding === null || row.state === "withdrawn") {
        return false;
      }
      const bound = storedTrackerBinding(row.trackerBinding);
      return closes.has(`${bound.repository}#${bound.issue}`);
    })
    .map((row) => row.id);
}

/**
 * Whether one source is finished: every pull request of its last publication merged with a
 * merge commit, and every tracker step of its items is verified (decision 29). A recall that
 * closed its pull requests because every code item above them is withdrawn also ends the
 * publication, once the branch holds nothing more to publish (decision 30).
 */
function finishedOf(db: CrewReader, sourceId: string): { finished: boolean; detail: string } {
  const state = stackStateOf(db, sourceId);
  const closedByRecall =
    state.state === "recalled" &&
    state.closed &&
    publishRecordsOf(db, sourceId).refusals.some((one) => one.reason === "nothing_to_publish");
  if (state.state !== "merged" && !closedByRecall) {
    return { finished: false, detail: `The last stack publication is ${state.state}.` };
  }
  for (const assignmentId of itemsOf(db, sourceId)) {
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
      /** Each fault no person has settled yet, with the approval that settles it. */
      settlements: Array<{
        part: number;
        number: number;
        fault: string;
        detail: string;
        approval: ApprovalRequest;
      }>;
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
  const state = await readState(request.projectRoot, (db) => stackStateOf(db, request.sourceId));
  if ("status" in state) {
    return state;
  }
  return {
    status: "observed",
    publication: publication.number,
    seen: observed.seen,
    settlements:
      state.state === "faulted"
        ? state.faults.map((one) => ({
            part: one.part,
            number: one.number,
            fault: one.fault,
            detail: one.detail,
            approval: one.settlement,
          }))
        : [],
    finish,
  };
}

export type RetargetResult =
  | { status: "retargeted"; part: number; number: number; how: "observed" | "written" }
  | { status: "not-due"; part: number; detail: string }
  | { status: "stack-fault"; part: number; detail: string }
  | { status: "approval-required"; approval: ApprovalRequest }
  | { status: "publish-unsettled"; sourceId: string }
  | { status: "unknown-source"; sourceId: string }
  | Exclude<ApplyResult, { status: "published" }>;

/**
 * Changes the base of one part to the target after the part below merged by a merge commit, under
 * the publish approval that already showed it (decision 15). The write reads GitHub first, so a
 * base that GitHub already changed is done with no write. A fault below stops it. It never merges.
 */
export async function retargetPublish(request: {
  projectRoot: string;
  requestId: string;
  ownerToken: string;
  sourceId: string;
  part: number;
}): Promise<RetargetResult> {
  const read = await readState(request.projectRoot, (db) => {
    const source = db.select().from(workSources).where(eq(workSources.id, request.sourceId)).all();
    const last = writtenPublicationOf(db, request.sourceId);
    return {
      known: source.length > 0,
      written: last?.written ?? null,
      due: retargetsDue(db, request.sourceId).find((one) => one.part === request.part) ?? null,
      lowest: last === null ? Number.POSITIVE_INFINITY : partsOf(db, last.publication).lowest,
    };
  });
  if ("status" in read) {
    return read;
  }
  if (!read.known) {
    return { status: "unknown-source", sourceId: request.sourceId };
  }
  if (read.written === false) {
    return { status: "publish-unsettled", sourceId: request.sourceId };
  }
  const { due } = read;
  if (due === null) {
    return request.part >= read.lowest
      ? {
          status: "stack-fault",
          part: request.part,
          detail:
            request.part === read.lowest
              ? `Part ${request.part} holds a stack fault, so it is stopped and keeps its base.`
              : `Part ${read.lowest} holds a stack fault, so part ${request.part} is stopped and keeps its base.`,
        }
      : {
          status: "not-due",
          part: request.part,
          detail: `Part ${request.part} has no retarget due: the part below has no recorded merge by a merge commit, or its retarget is recorded.`,
        };
  }
  if (!due.approved) {
    return { status: "approval-required", approval: due.approval };
  }
  const repository = await readState(request.projectRoot, (db) =>
    repositoryOf(db, request.sourceId),
  );
  if (typeof repository !== "string") {
    return repository;
  }
  const recorded = await mutate(
    {
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      ownerToken: request.ownerToken,
      now: new Date().toISOString(),
      operation: "publish_retarget",
      input: { sourceId: request.sourceId, part: request.part },
    },
    ({ tx, now }) => {
      // Another retarget recorded since the read is run by the same effects, not recorded twice.
      if (retargetedOf(tx, due.publicationId).has(due.number)) {
        return { commit: false, outcome: { status: "recorded" as const } };
      }
      const position = effectsOf(tx, due.publicationId).length;
      tx.insert(publishEffects)
        .values({
          id: crypto.randomUUID(),
          publicationId: due.publicationId,
          position,
          kind: "retarget",
          intent: JSON.stringify({
            kind: "retarget",
            repository,
            number: due.number,
            from: due.from,
            base: due.target,
          }),
          state: "intended",
          outcome: null,
          createdAt: now,
          settledAt: null,
        })
        .run();
      return { commit: true, outcome: { status: "recorded" as const } };
    },
  );
  if (recorded.result.status !== "recorded") {
    return recorded.result;
  }
  const ran = await runEffects(request, due.publicationId);
  if (ran.status !== "published") {
    return ran;
  }
  const outcome = await readState(request.projectRoot, (db) =>
    effectsOf(db, due.publicationId)
      .filter((one) => one.kind === "retarget")
      .map((one) => ({
        number: readStored("retarget intent", z.looseObject({ number: z.int() }), one.intent)
          .number,
        outcome: readStored(
          "retarget outcome",
          z.looseObject({ how: z.enum(["observed", "written"]) }),
          one.outcome ?? "{}",
        ),
      }))
      .find((one) => one.number === due.number),
  );
  if (outcome !== undefined && "status" in outcome) {
    return outcome;
  }
  return {
    status: "retargeted",
    part: due.part,
    number: due.number,
    how: outcome?.outcome.how ?? "observed",
  };
}
