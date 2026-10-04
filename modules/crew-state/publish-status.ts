import { eq } from "drizzle-orm";
import { z } from "zod";
import { HerdrControl } from "../herdr-control/main.ts";
import { PullRequestStack } from "../pull-request-stack/main.ts";
import { approvalCovers, matchApproval, PUBLISH_ACTION, readApproval } from "./approvals.ts";
import { publishRecordsOf } from "./publish-gate.ts";
import { faultsOf, partStatusesOf, publishBaseOf } from "./stack-parts.ts";
import {
  Publication,
  type PublicationFacts,
  type RetargetDue,
  type StackView,
} from "./publication-machine.ts";
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
  openEffectsOf,
  runEffects,
  trackerStepTarget,
} from "./publish.ts";
import { assignments, gateCheckouts, stackObservations, workSources } from "./schema.ts";
import {
  appendEffects,
  effectsOf,
  latestObservationOf,
  type ObservationRow,
  type PublicationRow,
  publicationsOf,
  pullsOf,
  repositoryOf,
  type StoredEffect,
  storedEffect,
  type WrittenPull,
  writtenPullsOf,
} from "./stack-records.ts";
import { readStored } from "./stored.ts";
import { latestSubmission, submittedCommit } from "./submission.ts";
import { readBinding, TRACKER_STEPS, targetOf, trackerOperationFor } from "./tracker.ts";
import { storedTrackerBinding, storedTrackerLocation } from "./work-input.ts";

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

/** A part reached the target with its commits, so the tracker steps of its items may run. */
function reachedTarget(seen: ObservationRow | null): seen is ObservationRow {
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
    for (const pull of pullsOf(db, publication.id)) {
      const seen = latestObservationOf(db, publication.id, pull.part);
      if (reachedTarget(seen) && seen.mergeCommit !== null) {
        // The reading names the number GitHub gave the pull request it read.
        merged.push({
          number: seen.number,
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
    last === null || !last.written
      ? []
      : last.pulls
          .filter(
            (pull) =>
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
  const pull = pullsOf(db, publication.id).find((one) => one.part === step.part);
  const seen = latestObservationOf(db, publication.id, step.part);
  if (pull?.number == null || !reachedTarget(seen)) {
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
  const pulls = writtenPullsOf(db, publication.id);
  return pulls === null || openEffectsOf(db, publication).length > 0
    ? { publication, written: false as const }
    : { publication, pulls, written: true as const };
}

/**
 * Each part of one written publication as the last readings show it. A fault on one part stops
 * every part above it (decision 20), so a part above the lowest fault is stopped, never due.
 */
function partsOf(db: CrewReader, publication: PublicationRow, written: WrittenPull[]) {
  const statuses = partStatusesOf(db, publication);
  const pulls = written.map((pull) => ({
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
 * `crew next` reads this, so it never reads GitHub (ADR 0016). The machine derives the state.
 */
export function stackStateOf(db: CrewReader, sourceId: string): StackView {
  const last = writtenPublicationOf(db, sourceId);
  if (last === null || !last.written) {
    return Publication.stateOf(
      last === null
        ? { last: "none" }
        : { last: "unwritten", publication: last.publication.number },
    );
  }
  const { pulls, faults } = partsOf(db, last.publication, last.pulls);
  return Publication.stateOf({
    last: "written",
    publication: last.publication.number,
    parts: pulls.map((one) => ({
      part: one.pull.part,
      number: one.pull.number,
      status: one.status,
    })),
    faults,
  });
}

/** What `crew next` reads of the stack publication of one source. */
export type PublishLane = {
  stack: StackView;
  /** True when the last publication holds a part that a new publication replaces. */
  superseded: boolean;
  /** True when a new publication replaces the ended parts, so it is offered instead of a settle. */
  replaces: boolean;
  /** True when a new publication of the head is offered. */
  offer: boolean;
  /** The number of the last publication, or 0 for none. */
  last: number;
};

/**
 * The stack publication of one source as `crew next` reads it (ADR 0022): the state of the last
 * publication, and whether a new one is offered. It reads the publish base and the publish
 * records once. It reads no Git and no GitHub.
 */
export function publishLaneOf(db: CrewReader, sourceId: string, tip: string): PublishLane {
  const { superseded } = publishBaseOf(db, sourceId);
  const last = publicationsOf(db, sourceId).at(-1);
  // A head that the last publication carries publishes again only when a recall, a close, or a
  // settled fault ended a part of it: then a new publication replaces that part. Only then are
  // the publish records read.
  const offer =
    (last?.headCommit !== tip || superseded) &&
    publishRecordsOf(db, sourceId).refusals.length === 0;
  return {
    stack: stackStateOf(db, sourceId),
    superseded,
    replaces: superseded && offer,
    offer,
    last: last?.number ?? 0,
  };
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

type RetargetIntent = Extract<StoredEffect, { kind: "retarget" }>;

/** Each retarget write of one publication, with its intent and its recorded outcome. */
function retargetsOf(db: CrewReader, publicationId: string) {
  return effectsOf(db, publicationId).flatMap((one) => {
    const intent = storedEffect(one.intent);
    return intent.kind === "retarget" ? [{ intent, outcome: one.outcome }] : [];
  });
}

/** The pull request numbers one publication already has a retarget write for. */
function retargetedOf(db: CrewReader, publicationId: string): Set<number> {
  return new Set(retargetsOf(db, publicationId).map((one) => one.intent.number));
}

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
  const { pulls, lowest } = partsOf(db, last.publication, last.pulls);
  const retargeted = retargetedOf(db, last.publication.id);
  return pulls.flatMap(({ pull, seen }, index) => {
    const below = pulls[index - 1];
    const due =
      below !== undefined &&
      pull.part < lowest &&
      below.seen?.state === "merged" &&
      below.seen.fault === null &&
      !retargeted.has(pull.number) &&
      // A recalled part, or one above a recalled part, waits for the publication that replaces it.
      pulls.slice(0, index + 1).every((one) => one.status === "open" || one.status === "merged") &&
      (seen === null || seen.state === "open");
    if (!due) {
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
  const facts = await readState(request.projectRoot, (db): PublicationFacts["observe"] => {
    const source = db
      .select()
      .from(workSources)
      .where(eq(workSources.id, request.sourceId))
      .all()[0];
    const last = writtenPublicationOf(db, request.sourceId);
    return {
      sourceId: request.sourceId,
      known: source !== undefined,
      stack: stackStateOf(db, request.sourceId),
      written: last?.written === true ? { publication: last.publication, pulls: last.pulls } : null,
      repository:
        source?.trackerLocation == null
          ? null
          : storedTrackerLocation(source.trackerLocation).repository,
    };
  });
  if ("status" in facts) {
    return facts;
  }
  const decided = Publication.decide("observe", facts);
  if ("refused" in decided) {
    return decided.refused;
  }
  const { publication, pulls, repository } = decided.next;
  const observed = await PullRequestStack.observe({
    repository,
    target: publication.target,
    pullRequests: pulls.map((one) => ({
      part: one.part,
      number: one.number,
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
  const facts = await readState(request.projectRoot, (db): PublicationFacts["retarget"] => {
    const source = db.select().from(workSources).where(eq(workSources.id, request.sourceId)).all();
    const last = writtenPublicationOf(db, request.sourceId);
    return {
      sourceId: request.sourceId,
      part: request.part,
      known: source.length > 0,
      stack: stackStateOf(db, request.sourceId),
      due: retargetsDue(db, request.sourceId).find((one) => one.part === request.part) ?? null,
      lowest:
        last?.written === true
          ? partsOf(db, last.publication, last.pulls).lowest
          : Number.POSITIVE_INFINITY,
    };
  });
  if ("status" in facts) {
    return facts;
  }
  const decided = Publication.decide("retarget", facts);
  if ("refused" in decided) {
    return decided.refused;
  }
  const { due } = decided.next;
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
      const retarget: RetargetIntent = {
        kind: "retarget",
        repository,
        number: due.number,
        from: due.from,
        base: due.target,
      };
      appendEffects(tx, { publicationId: due.publicationId, effects: [retarget], now });
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
  const how = await readState(request.projectRoot, (db) => {
    const retarget = retargetsOf(db, due.publicationId).find(
      (one) => one.intent.number === due.number,
    );
    return retarget === undefined
      ? "observed"
      : readStored(
          "retarget outcome",
          z.looseObject({ how: z.enum(["observed", "written"]) }),
          retarget.outcome ?? "{}",
        ).how;
  });
  if (typeof how !== "string") {
    return how;
  }
  return { status: "retargeted", part: due.part, number: due.number, how };
}
