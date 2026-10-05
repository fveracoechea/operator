import { readAssignment } from "./assignment.ts";
import { type Capacity } from "./capacity.ts";
import {
  CLEANUP_KINDS,
  type CleanupKind,
  type CleanupState,
  cleanupRecordOf,
  heldRetention,
  readCleanup,
} from "./cleanup.ts";
import { Cleanup } from "./cleanup-machine.ts";
import type { CrewReader } from "./database.ts";
import { Attempt, unsettledOperations } from "./attempt-machine.ts";
import { liveOperations, readDispatchRow } from "./dispatch.ts";
import {
  type BaseGate,
  baseGateOf,
  candidateGateOf,
  type GateStatus,
  isFirstCodeDispatch,
  runningRunOf,
} from "./gate-runs.ts";
import { unlandedCommitOf } from "./cleanup-landing.ts";
import { currentLandingOf, intendedLandingOf, replacedLandingOf } from "./landing-record.ts";
import { pendingTakeOutsOf, type TakeOutRead, takeOutCommand, takeOutOf } from "./take-out.ts";
import { integrationBranchOf } from "./integration.ts";
import { directionRecordOf } from "./direction.ts";
import { calculateFrontier, type Frontier, undirected, unmetDependencies } from "./frontier.ts";
import { openPauses } from "./invalidate.ts";
import { type OutsideChangeRow, outsideChangesOfSubmission } from "./outside-changes.ts";
import { type DependencyRecord, dependencyRecords } from "./planning-record.ts";
import { currentOwnership } from "./ownership.ts";
import { blockingQuestions, triggersOf } from "./questions.ts";
import { findingsOf, reviewOfAssignment, reviewOfSubmission, undisposed } from "./review.ts";
import { Review } from "./review-machine.ts";
import { readSnapshot } from "./branch-review.ts";
import { openCycleOf } from "./rework.ts";
import { assignments, attempts, workSources } from "./schema.ts";
import type { BrokenLanding, RewriteRead } from "./next-landings.ts";
import { openPublicationOf } from "./publish.ts";
import { storedEffect } from "./stack-records.ts";
import { approvedRebaseOf, intendedRebaseOf } from "./rebase.ts";
import { grantedApprovalsOf, PUBLISH_ACTION } from "./approvals.ts";
import { recallOffer } from "./recall.ts";
import { conflictSettlementOf } from "./stack-parts.ts";
import type { RetargetDue } from "./publication-machine.ts";
import {
  type MergeGate,
  mergeGateOf,
  type PublishLane,
  publishLaneOf,
  retargetsDue,
} from "./publish-status.ts";
import { latestSubmission, readSubmission, submittedCommit } from "./submission.ts";
import {
  readBinding,
  TRACKER_STEPS,
  type TrackerOperationRow,
  targetOf,
  trackerOperationsOf,
} from "./tracker.ts";
import { TrackerStep } from "./tracker-machine.ts";
import { mapAmendmentOffer } from "./map-amendment.ts";
import { isReview } from "./work-input.ts";

/**
 * Everything one crew can do next, in one order.
 * A recovery comes before a conversation, a conversation before a pipeline step, and a launch
 * last, so a session never starts new work while an unproven effect or an unanswered question
 * is still open.
 */
export const NEXT_ACTIONS = [
  "prove_readiness",
  "own_crew",
  "reconcile_attempt",
  "settle_landing",
  "settle_rebase",
  "settle_publish",
  "adopt_attempt",
  "recover_tracker",
  "settle_cleanup",
  "replace_attempt",
  "answer_question",
  "deliver_answer",
  "dispose_findings",
  "delegate_rework",
  "dispose_outside_changes",
  "take_out_commit",
  "accept_assignment",
  "resolve_planning",
  "rebase_integration",
  "publish_stack",
  "retarget_pull_request",
  "record_tracker",
  "close_process",
  "remove_worktree",
  "direct_limit",
  "recall_stack",
  "run_gate",
  "dispatch_attempt",
  "claim_assignment",
] as const;

export type NextActionName = (typeof NEXT_ACTIONS)[number];

/**
 * The actions that are standing preconditions rather than work this crew owes.
 * One is reported first and reaches the blockers a session brings to the user, and it never
 * decides whether the crew can advance: settling it starts no work, and a running Operative is
 * unaffected by it.
 */
const STANDING_ACTIONS: readonly string[] = ["prove_readiness"] satisfies NextActionName[];

/**
 * What a session may do on its own after one schedule, which is what the exit meaning reports.
 * A crew action that waits on a person outranks a wait, because waiting settles nothing a
 * person holds and a session would read a wait as permission to do nothing about it.
 */
type NextVerdict = {
  outcome: "completed" | "missing-condition" | "pending";
  reason:
    | "next_actions_reported"
    | "next_actions_blocked"
    | "next_actions_waiting"
    | "next_actions_none";
  /** True when the schedule holds an action this crew owes, blocked or not. */
  owed: boolean;
};

/**
 * The verdict of one schedule. It reads only the action names, their blockers, and the waits, so
 * the schedule that the CLI prints as JSON gives the same verdict as the one this module reads.
 */
export function verdictOf(schedule: {
  actions: readonly { action: string; blocker: string | null }[];
  waits: readonly unknown[];
}): NextVerdict {
  // A standing precondition is reported and is never the reason the crew cannot advance.
  const owed = schedule.actions.filter((one) => !STANDING_ACTIONS.includes(one.action));
  const verdict = (outcome: NextVerdict["outcome"], reason: NextVerdict["reason"]) => ({
    outcome,
    reason,
    owed: owed.length > 0,
  });

  if (owed.some((one) => one.blocker === null))
    return verdict("completed", "next_actions_reported");
  if (owed.length > 0) return verdict("missing-condition", "next_actions_blocked");
  if (schedule.waits.length > 0) return verdict("pending", "next_actions_waiting");
  if (schedule.actions.length > 0) return verdict("missing-condition", "next_actions_blocked");
  return verdict("completed", "next_actions_none");
}

/**
 * Every action that names a blocker, under the blocker as its reason. A schedule whose verdict
 * says a person must decide therefore always names what to decide.
 */
function blockersOf(actions: NextAction[]) {
  return actions.flatMap((one) =>
    one.blocker === null
      ? []
      : [
          {
            reason: one.blocker,
            action: one.action,
            assignmentId: one.assignmentId,
            attemptId: one.attemptId,
            questionId: one.questionId,
            reviewId: one.reviewId,
            detail: one.detail,
          },
        ],
  );
}

/**
 * What a person has to settle before one action can run.
 * An action carries one of these or it carries nothing, so a session that holds only blocked
 * actions always has something to bring to the user.
 */
export const NEXT_BLOCKERS = [
  "readiness_blocked",
  "escalation_required",
  "direction_required",
  "approval_required",
  "cleanup_blocked",
  "cleanup_failed",
  "cleanup_uncertain",
  "gate_failed",
  "gate_flaky",
  "publish_conflict",
  "publish_failed",
  "stack_fault",
] as const;

export type NextBlocker = (typeof NEXT_BLOCKERS)[number];

/** The waits a session may hold. Each one names what has to answer before anything moves. */
export const NEXT_WAITS = [
  "acknowledgement_pending",
  "answer_acknowledgement_pending",
  "operative_working",
  "cleanup_held",
  "input_invalidated",
  "gate_running",
  "stack_open",
] as const;

export type NextWaitName = (typeof NEXT_WAITS)[number];

export type NextAction = {
  action: NextActionName;
  rank: number;
  /** The source a publish action names. Every other action names its assignment instead. */
  sourceId: string | null;
  assignmentId: string | null;
  attemptId: string | null;
  questionId: string | null;
  reviewId: string | null;
  /** The record revision a mutation on this subject must state, when it has one. */
  revision: number | null;
  /** What a person must settle first, or null when this session can act alone. */
  blocker: NextBlocker | null;
  /**
   * The records of the direct planning dependencies of planning work to resolve. Planning work
   * has no brief, so this action carries them. It is null for every other action.
   */
  planningRecords: DependencyRecord[] | null;
  detail: string;
  command: string;
};

export type NextWait = {
  wait: NextWaitName;
  /** The work this wait holds, or null for a wait that names its source instead. */
  assignmentId: string | null;
  /** The source a publish wait names. Every other wait names its assignment instead. */
  sourceId: string | null;
  attemptId: string | null;
  /** The Herdr agent a bounded wait watches, when this wait has one. */
  agentName: string | null;
  /** The read a person's report triggers, when this wait names one. */
  command: string | null;
  detail: string;
};

export type CrewNext = {
  status: "reported";
  ownership: { ownerLabel: string; acquiredAt: string; revision: number } | null;
  capacity: Frontier["capacity"];
  actions: NextAction[];
  waits: NextWait[];
  frontier: Frontier;
  verdict: NextVerdict;
  blockers: ReturnType<typeof blockersOf>;
};

export type Readiness = { ready: boolean; detail: string };

/** The place one action holds in the declared order. The list is total, so no name is missing. */
function rankOf(action: NextActionName): number {
  return (NEXT_ACTIONS.indexOf(action) + 1) * 10;
}

/** One action as a reader states it. Everything it does not name is absent, not null. */
type Draft = {
  action: NextActionName;
  detail: string;
  command: string;
  sourceId?: string;
  assignmentId?: string;
  attemptId?: string;
  questionId?: string;
  reviewId?: string;
  revision?: number;
  blocker?: NextBlocker;
  planningRecords?: DependencyRecord[];
};

/**
 * Collects one reading of the crew.
 * Actions come back in the declared order, and the waits travel with them, so a caller never
 * carries the two halves of one report separately.
 */
function collector() {
  const held: Array<{ action: NextAction; order: number }> = [];
  const waiting: NextWait[] = [];

  return {
    add(draft: Draft): void {
      held.push({
        action: {
          rank: rankOf(draft.action),
          sourceId: null,
          assignmentId: null,
          attemptId: null,
          questionId: null,
          reviewId: null,
          revision: null,
          blocker: null,
          planningRecords: null,
          ...draft,
        },
        order: held.length,
      });
    },
    wait(
      entry: Pick<NextWait, "wait" | "detail"> &
        Partial<Omit<NextWait, "wait" | "detail">> &
        ({ assignmentId: string } | { sourceId: string }),
    ): void {
      waiting.push({
        assignmentId: null,
        sourceId: null,
        attemptId: null,
        agentName: null,
        command: null,
        ...entry,
      });
    },
    actions(): NextAction[] {
      return held
        .toSorted((left, right) => left.action.rank - right.action.rank || left.order - right.order)
        .map((one) => one.action);
    },
    waits(): NextWait[] {
      return waiting;
    },
  };
}

type Collector = ReturnType<typeof collector>;

/**
 * The settle of one publication with a write that is not done. A recall is settled by a repeat
 * of the recall, every other write by a repeat of the apply, and a conflict on an existing pull
 * request names the approval by which the person settles it (#120).
 */
function settleDraft(
  db: CrewReader,
  sourceId: string,
  open: NonNullable<ReturnType<typeof openPublicationOf>>,
): Draft {
  const states = open.open.map((one) => one.state);
  const [first] = open.open;
  const intent = first === undefined ? null : storedEffect(first.intent);
  const recall =
    intent !== null && (intent.kind === "recall" || intent.kind === "close")
      ? (intent.recall ?? null)
      : null;
  const settlements = open.open.flatMap((one) => {
    const settlement = conflictSettlementOf(db, sourceId, one);
    return settlement === null ? [] : [settlement];
  });
  const settle: Draft = {
    action: "settle_publish",
    sourceId,
    detail: [
      `Stack publication ${open.publication.number} holds ${open.open.length} write(s) with no done outcome: ${states.join(", ")}. The command reads GitHub first and writes only what is missing; a conflict or a refused write waits on a person.`,
      ...settlements.map(
        (one) =>
          `When the person accepts the conflict on ${one.targets.join(", ")} as GitHub shows it, record their approval: action ${one.action}, scope ${one.scope}, targets ${one.targets.join(", ")}, request revision ${one.requestRevision}.`,
      ),
    ].join(" "),
    command:
      recall === null
        ? `operator publish apply --source ${sourceId} --plan-revision ${open.publication.planRevision}`
        : `operator publish recall --source ${sourceId} --plan-revision ${recall}`,
  };
  // A conflict, or a write GitHub refused, is settled by a person, never written over.
  if (states.includes("conflict")) {
    settle.blocker = "publish_conflict";
  } else if (states.includes("failed")) {
    settle.blocker = "publish_failed";
  }
  return settle;
}

/** The recall one source owes before a change after publish, behind its approval (decision 23). */
function recallDraft(db: CrewReader, sourceId: string): Draft | null {
  const recall = recallOffer(db, sourceId);
  if (recall === null) {
    return null;
  }
  const offer: Draft = {
    action: "recall_stack",
    sourceId,
    detail: `A commit to change is inside stack publication ${recall.publication}, which people still read: ${recall.numbers.map((one) => `#${one}`).join(", ")}. The recall turns each one into a draft with one comment that names the reason${recall.replaced ? "" : ", and closes it, because no new stack publication will replace it"}. The rewrite or the take-out refuses until it is done.`,
    command: recall.approved
      ? `operator publish recall --request <id> --owner-token <token> --source ${sourceId} --plan-revision ${recall.planRevision}`
      : `operator publish recall --source ${sourceId}`,
  };
  if (!recall.approved) {
    offer.blocker = "approval_required";
  }
  return offer;
}

/**
 * The publish of each source (ADR 0022). A publication with a write that is not done is settled
 * first, by a repeat of the apply that reads GitHub before it writes. A source whose records
 * pass the publish gate and that holds no publication of its head is offered `publish_stack`,
 * which waits on the approval of a plan revision. This reads no Git and no GitHub.
 */
function readPublish(db: CrewReader, into: Collector): void {
  for (const source of db.select().from(workSources).all()) {
    const branch = integrationBranchOf(db, source.id);
    if (branch === null) {
      continue;
    }
    const open = openPublicationOf(db, source.id);
    if (open !== null) {
      into.add(settleDraft(db, source.id, open));
      continue;
    }
    const recall = recallDraft(db, source.id);
    if (recall !== null) {
      into.add(recall);
    }
    const lane = publishLaneOf(db, source.id, branch.recordedTip);
    readStack(source.id, lane, into);
    for (const due of retargetsDue(db, source.id)) {
      into.add(retargetDraft(source.id, due));
    }
    if (lane.offer) {
      into.add(publishDraft(db, source.id, lane));
    }
  }
}

/** The sentence that names the parts a fault stops, or nothing when it stops none. */
function stoppedText(stopped: number[]): string[] {
  return stopped.length === 0
    ? []
    : [
        `A fault stops every part above it, so ${stopped.map((one) => `part ${one}`).join(" and ")} are stopped.`,
      ];
}

/**
 * What the state of the last publication asks for. No event reaches the crew when a pull request
 * merges, so the wait names the read that the user's report of a merge or a close triggers. This
 * reads only what that read recorded.
 */
function readStack(sourceId: string, lane: PublishLane, into: Collector): void {
  const { stack } = lane;
  const status = `operator publish status --source ${sourceId}`;
  if (stack.state === "faulted") {
    into.add({
      action: "settle_publish",
      sourceId,
      blocker: "stack_fault",
      detail: [
        `Stack publication ${stack.publication} has a stack fault that a person settles. Operator adopts nothing from it: ${stack.faults.map((one) => `#${one.number} ${one.fault}: ${one.detail}`).join(" ")}`,
        ...stoppedText(stack.stopped),
        `When the person accepts the fault as GitHub shows it, record their approval that \`${status}\` names. Run the read again when the person reports a change on GitHub.`,
      ].join(" "),
      command: status,
    });
  } else if (stack.state === "ended" && !lane.replaces) {
    // A settled fault ends its part, and the parts above it stay stopped: only a new stack
    // publication carries their commits to the target, after a recall or a rebase.
    into.add({
      action: "settle_publish",
      sourceId,
      blocker: "stack_fault",
      detail: [
        `Stack publication ${stack.publication} is settled, and its commits did not all reach the target.`,
        ...(stack.ended.length === 0
          ? []
          : [
              `${stack.ended.map((one) => `#${one.number} (${one.fault})`).join(", ")} ended with no merge commit.`,
            ]),
        ...stoppedText(stack.stopped),
        "Their commits reach the target only through a new stack publication, after a rebase onto the target that the person approves. Plan it with `operator work rebase --source <id> --base <the target tip>`, and the next publication closes each pull request it replaces.",
      ].join(" "),
      command: status,
    });
  } else if (stack.state === "open") {
    into.wait({
      wait: "stack_open",
      sourceId,
      command: status,
      detail: `Stack publication ${stack.publication} has open pull request(s) ${stack.open.map((one) => `#${one}`).join(", ")}. A person merges them on GitHub with a merge commit, from the bottom up. Run \`${status}\` when the user reports a merge or a close, or asks for the state.`,
    });
  }
}

/** The retarget of one part whose part below merged by a merge commit (decision 15). */
function retargetDraft(sourceId: string, due: RetargetDue): Draft {
  const retarget: Draft = {
    action: "retarget_pull_request",
    sourceId,
    detail: `Part ${due.part - 1} merged by a merge commit, so part ${due.part} (#${due.number}) changes its base from ${due.from} to ${due.target}, under the publish approval that showed it. The write reads GitHub first.`,
    command: `operator publish retarget --request <id> --owner-token <token> --source ${sourceId} --part ${due.part}`,
  };
  if (!due.approved) {
    retarget.blocker = "approval_required";
  }
  return retarget;
}

/** The offer of a new stack publication, which waits on the approval of its plan revision. */
function publishDraft(db: CrewReader, sourceId: string, lane: PublishLane): Draft {
  const approved = grantedApprovalsOf(db, PUBLISH_ACTION, sourceId).length > 0;
  const offer: Draft = {
    action: "publish_stack",
    sourceId,
    detail: [
      approved
        ? "A publish approval is recorded for this source. Apply the plan revision it names."
        : "The branch review and the gate records pass. Plan the publish, and ask the person to read and approve the plan revision.",
      ...(lane.superseded
        ? [
            `It replaces the parts of stack publication ${lane.last} that a recall, a close, or a settled fault ended, and closes each one that is still open with a pointer. When the target moved, a rebase that the person approves can come first: \`operator work rebase --source ${sourceId} --base <the target tip>\`.`,
          ]
        : []),
    ].join(" "),
    command: approved
      ? `operator publish apply --source ${sourceId} --plan-revision <the approved revision>`
      : `operator publish plan --source ${sourceId}`,
  };
  if (!approved) {
    offer.blocker = "approval_required";
  }
  return offer;
}

/**
 * The rebase of each source onto a new base (ADR 0022). A rebase whose move has no recorded
 * outcome is settled first, by a repeat of the same command. A granted `integration-rebase`
 * approval that no rebase used yet, whose old base is still the base, is offered as the rebase
 * to run: the command gates the new base and each commit first, and names the next gate run.
 * This reads no Git.
 */
function readRebase(db: CrewReader, into: Collector): void {
  for (const source of db.select().from(workSources).all()) {
    const branch = integrationBranchOf(db, source.id);
    if (branch === null) {
      continue;
    }
    const open = intendedRebaseOf(db, source.id);
    if (open !== null) {
      into.add({
        action: "settle_rebase",
        sourceId: source.id,
        detail: `Rebase ${open.id} moves ${open.branch} from ${open.fromTip} to ${open.toTip} on the new base ${open.toBase}, and its outcome is not recorded. Repeat it: it reads the branch once and moves it again, records the outcome, or names a moved branch.`,
        command: `operator work rebase --source ${source.id} --base ${open.toBase} --plan-revision ${open.planRevision}`,
      });
      continue;
    }
    const approved = approvedRebaseOf(db, branch);
    if (approved === null) {
      continue;
    }
    // The rebase starts gate runs of its own, so it waits for the run in progress.
    if (waitsForRun(db, source.id, { sourceId: source.id }, into)) {
      continue;
    }
    into.add({
      action: "rebase_integration",
      sourceId: source.id,
      detail: `An integration-rebase approval of ${branch.name} onto ${approved.newBase} is recorded. Run the rebase: it moves the branch only after the new base and each commit that lands again passed the project gate, and it names the next gate run until then.`,
      command: `operator work rebase --source ${source.id} --base ${approved.newBase} --plan-revision ${approved.planRevision}`,
    });
  }
}

/** The attempts of one crew, oldest first, so a report reads them in the order they started. */
function allAttempts(db: CrewReader) {
  return db
    .select()
    .from(attempts)
    .all()
    .toSorted(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
    );
}

/**
 * The gate run that the first code dispatch of one source waits for. A source is reported once,
 * however many of its attempts wait. A failed or flaky base has no assignment to correct it, so
 * only the user clears it.
 */
function readBaseGate(
  base: { sourceId: string; gate: BaseGate; reported: Set<string> },
  request: { assignmentId: string; attemptId: string },
  into: Collector,
): void {
  if (base.reported.has(base.sourceId)) {
    return;
  }
  base.reported.add(base.sourceId);
  const { gate } = base;
  const subject = { assignmentId: request.assignmentId, attemptId: request.attemptId };

  switch (gate.status) {
    case "running":
      into.wait({
        wait: "gate_running",
        ...subject,
        detail: `Gate run ${gate.run.id} of source ${base.sourceId} runs at commit ${gate.run.commit}. Its runner wakes the Operator at the end. If its pane shows no runner, \`operator gate run\` replaces it.`,
      });
      return;
    case "failed":
    case "flaky":
      into.add({
        action: "run_gate",
        ...subject,
        blocker: gate.status === "failed" ? "gate_failed" : "gate_flaky",
        detail: `The integration base of source ${base.sourceId} is ${gate.status} at commit ${gate.commit} in gate run ${gate.failed.map((one) => one.id).join(", ")}, and it is not fixed. Only the user clears it: by a fixed main branch and a new base commit, or by an approval of a fresh series that names the key and each failed run. Read a run with \`operator gate show --run <id>\`.`,
        command: "operator gate run",
      });
      return;
    case "pending":
      into.add({
        action: "run_gate",
        ...subject,
        detail: `The first code dispatch of source ${base.sourceId} fixes its integration base, so the base commit passes the project gate first. Run the gate on the commit you will dispatch from.${gate.stopped === null ? "" : ` Gate run ${gate.stopped.id} stopped with no outcome: ${gate.stopped.detail ?? "no reason recorded"}.`}`,
        command: "operator gate run",
      });
      return;
    case "passed":
      return;
  }
}

/** The head one branch review reads, or null when the assignment is not a branch review. */
function branchHeadOf(db: CrewReader, assignmentId: string): string | null {
  const review = reviewOfAssignment(db, assignmentId);
  return review?.snapshotId == null
    ? null
    : (readSnapshot(db, review.snapshotId)?.headCommit ?? null);
}

/**
 * The integration branch that a new launch of one assignment starts from: a production
 * assignment with no open cycle or an open integration cycle, of a source that recorded its
 * branch (ADR 0020, ADR 0008).
 */
function tipStartOf(
  db: CrewReader,
  assignment: { id: string; kind: string; sourceId: string },
): { name: string; recordedTip: string; place: string } | null {
  const cycle = openCycleOf(db, assignment.id);
  if (assignment.kind !== "production" || (cycle !== null && cycle.reason !== "integration")) {
    return null;
  }
  const row = integrationBranchOf(db, assignment.sourceId);
  if (row === null) {
    return null;
  }
  // An integration cycle of a correction lands in the place of the landed commit, on its parent.
  const landed = cycle === null ? null : currentLandingOf(db, assignment.id);
  return landed === null
    ? { name: row.name, recordedTip: row.recordedTip, place: `the recorded tip of ${row.name}` }
    : {
        name: row.name,
        recordedTip: landed.landedParent,
        place: `the parent of ${landed.landedCommit} on ${row.name}`,
      };
}

/**
 * The submitted commit that a launch names with `--commit`: the result a review reads, or the
 * result a findings or diagnostic cycle reworks. The attempt that submitted it has ended, so
 * `crew next` is where the Operator reads it. Null for every other launch.
 */
function submittedStartOf(
  db: CrewReader,
  assignment: { id: string; kind: string },
): { commit: string; role: string } | null {
  if (isReview(assignment.kind)) {
    const review = reviewOfAssignment(db, assignment.id);
    const submission =
      review?.submissionId == null ? null : readSubmission(db, review.submissionId);
    const commit = submission === null ? null : submittedCommit(submission);
    return commit === null ? null : { commit, role: "This review reads the submitted commit" };
  }
  const cycle = openCycleOf(db, assignment.id);
  if (cycle === null || (cycle.reason !== "findings" && cycle.reason !== "diagnostic")) {
    return null;
  }
  const submission = readSubmission(db, cycle.submissionId);
  const commit = submission === null ? null : submittedCommit(submission);
  return commit === null
    ? null
    : { commit, role: `This ${cycle.reason} cycle reworks the submitted commit` };
}

const LAUNCHING = "This launch is planned and has not finished every effect.";

/** What a claimed attempt with no plan starts from, which its dispatch command follows. */
function claimedDetail(request: {
  baseGate: { gate: BaseGate } | null;
  integration: { recordedTip: string; place: string } | null;
  branchHead: string | null;
  submitted: { commit: string; role: string } | null;
}): string {
  const base = request.baseGate?.gate;
  if (base?.status === "passed") {
    return `This assignment is claimed and has no Operative yet. The integration base passed the gate at commit ${base.commit} in gate run ${base.run.id}, so dispatch from that commit.`;
  }
  if (request.submitted !== null) {
    return `This assignment is claimed and has no Operative yet. ${request.submitted.role} ${request.submitted.commit}, so dispatch with --commit ${request.submitted.commit}.`;
  }
  if (request.integration !== null) {
    return `This assignment is claimed and has no Operative yet. It starts from ${request.integration.recordedTip}, ${request.integration.place}, so dispatch with no --commit.`;
  }
  return request.branchHead === null
    ? "This assignment is claimed and has no Operative yet."
    : `This branch review is claimed and has no reviewer yet. It reads the branch snapshot at head ${request.branchHead}, so dispatch with no --commit.`;
}

/** One active attempt: what it still owes, or what it is waiting for. */
function readActiveAttempt(
  db: CrewReader,
  request: {
    attemptId: string;
    assignmentId: string;
    ownedByCurrent: boolean;
    unsettled: string[];
    /** The base gate of the source when this is its first code dispatch, or null. */
    baseGate: { sourceId: string; gate: BaseGate; reported: Set<string> } | null;
    /** The integration branch a new production launch starts from, or null. */
    integration: { name: string; recordedTip: string; place: string } | null;
    /** The head a branch review reads, or null for every other assignment. */
    branchHead: string | null;
    /** The submitted commit a review or a findings or diagnostic cycle starts from, or null. */
    submitted: { commit: string; role: string } | null;
  },
  into: Collector,
): void {
  const dispatch = readDispatchRow(db, request.attemptId);
  const launch = Attempt.launchState(dispatch, liveOperations(db, request.attemptId));

  if (request.unsettled.length > 0) {
    into.add({
      action: "reconcile_attempt",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      detail: `${request.unsettled.join(", ")} never proved an outcome.`,
      command: "operator attempt reconcile",
    });
    return;
  }

  if (!request.ownedByCurrent) {
    into.add({
      action: "adopt_attempt",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      detail: "A replaced Operator claimed this attempt, so this session cannot change it yet.",
      command: "operator attempt adopt",
    });
    return;
  }

  // The first code dispatch of a source fixes its integration base, so it waits for the gate.
  if (
    launch === "unplanned" &&
    request.baseGate !== null &&
    request.baseGate.gate.status !== "passed"
  ) {
    readBaseGate(request.baseGate, request, into);
    return;
  }

  // A launch that has not finished every effect resumes at the first one that is unfinished,
  // which is the same command that started it.
  if (launch === "unplanned" || launch === "launching" || dispatch === null) {
    into.add({
      action: "dispatch_attempt",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      detail: launch === "launching" ? LAUNCHING : claimedDetail(request),
      // A new launch of submitted work names its commit, which no other record shows the Operator.
      command:
        launch === "unplanned" && request.submitted !== null
          ? `operator attempt dispatch --attempt ${request.attemptId} --commit ${request.submitted.commit}`
          : "operator attempt dispatch",
    });
    return;
  }

  into.wait({
    wait: launch === "awaiting-acknowledgement" ? "acknowledgement_pending" : "operative_working",
    assignmentId: request.assignmentId,
    attemptId: request.attemptId,
    agentName: dispatch.agentName,
    detail:
      launch === "awaiting-acknowledgement"
        ? "Herdr accepted the submission. The Operative has not acknowledged the brief."
        : "The Operative acknowledged its brief and is working.",
  });
}

/** Every question that still holds an Operative, and what carries it forward. */
function readQuestions(db: CrewReader, unsettled: Set<string>, into: Collector): void {
  for (const row of blockingQuestions(db).toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const triggers = triggersOf(row);
    if (row.state === "open") {
      const action: Draft = {
        action: "answer_question",
        assignmentId: row.assignmentId,
        attemptId: row.attemptId,
        questionId: row.id,
        revision: row.revision,
        detail:
          triggers.length > 0
            ? `This question names ${triggers.join(", ")}, so only a person may settle it.`
            : "This question is inside delegated authority.",
        command: "operator question answer",
      };
      if (triggers.length > 0) action.blocker = "escalation_required";
      into.add(action);
      continue;
    }

    // A delivery that never proved an outcome is reconciled, never submitted a second time.
    if (row.state === "answered" && !unsettled.has(row.attemptId)) {
      into.add({
        action: "deliver_answer",
        assignmentId: row.assignmentId,
        attemptId: row.attemptId,
        questionId: row.id,
        revision: row.revision,
        detail: "The answer is recorded and has not reached the Operative.",
        command: "operator question deliver",
      });
      continue;
    }
    if (row.state === "answered") {
      continue;
    }

    into.wait({
      wait: "answer_acknowledgement_pending",
      assignmentId: row.assignmentId,
      attemptId: row.attemptId,
      agentName: readDispatchRow(db, row.attemptId)?.agentName ?? null,
      detail: "The answer was submitted. The Operative has not acknowledged it.",
    });
  }
}

/** The review of one submitted result, and the step it now owes. */
function readReview(
  db: CrewReader,
  request: {
    assignmentId: string;
    revision: number;
    sourceId: string;
    broken: Map<string, BrokenLanding>;
    rewrites: Map<string, RewriteRead>;
    takeOutWaits: Set<string>;
  },
  into: Collector,
): void {
  const submission = latestSubmission(db, request.assignmentId);
  const review = submission === null ? null : reviewOfSubmission(db, submission.id);
  if (submission === null || review === null) {
    return;
  }

  const subject = {
    assignmentId: request.assignmentId,
    reviewId: review.id,
    revision: request.revision,
  };

  const owed = Review.owed({
    row: review,
    findings: findingsOf(db, review.id),
    outside: outsideChangesOfSubmission(db, submission.id),
  });
  if (owed.owes === "report") {
    return;
  }
  if (owed.owes === "replace") {
    into.add({
      ...subject,
      action: "replace_attempt",
      detail: "The review stopped before it reported. Correct what it names, then replace it.",
      command: "operator attempt replace",
    });
    return;
  }
  if (owed.owes === "dispose") {
    into.add({
      ...subject,
      action: "dispose_findings",
      detail: `${owed.findings.length} finding(s) carry no disposition.`,
      command: "operator review dispose",
    });
    return;
  }
  // Every later step waits while delegated rework is open.
  if (openCycleOf(db, request.assignmentId) !== null) {
    return;
  }
  if (owed.owes === "rework") {
    into.add({
      ...subject,
      action: "delegate_rework",
      detail: `${owed.findings.length} accepted correction(s) wait for a fresh Operative.`,
      command: "operator work rework",
    });
    return;
  }
  if (owed.owes === "outside") {
    into.add(outsideDraft(subject, owed.changes));
    return;
  }
  if (submittedCommit(submission) !== null) {
    readLanding(
      db,
      {
        ...subject,
        sourceId: request.sourceId,
        submissionId: submission.id,
        broken: request.broken.get(submission.id) ?? null,
        rewrite: request.rewrites.get(submission.id) ?? null,
        takeOutWaits: request.takeOutWaits.has(request.sourceId),
      },
      into,
    );
    return;
  }
  into.add({
    ...subject,
    action: "accept_assignment",
    detail: "The review reported and every finding carries a disposition.",
    command: "operator work accept",
  });
}

/**
 * The step for the outside changes of one result that carry no disposition. A change to a hook
 * or the checkout config is a security permission, so the user decides.
 */
function outsideDraft(
  subject: { assignmentId: string; reviewId: string; revision: number },
  outside: OutsideChangeRow[],
): Draft {
  const security = outside.filter((one) => one.security === 1).length;
  const draft: Draft = {
    ...subject,
    action: "dispose_outside_changes",
    detail: `${outside.length} outside change(s) carry no disposition${security > 0 ? `, and ${security} touch a security permission` : ""}. Read them with \`operator review show\`.`,
    command: "operator work dispose",
  };
  if (security > 0) {
    draft.blocker = "approval_required";
  }
  return draft;
}

/**
 * The take-out of each source whose integration branch still holds a withdrawn commit (ADR
 * 0020). It comes ahead of every landing of the source, so no landing is gated twice. A
 * take-out whose move has no recorded outcome is settled by a repeat of the command. Otherwise
 * each commit of the rebuilt range passes the project gate first, one `run_gate` at a time, and
 * the command is then offered with the plan revision that recorded the withdrawals (D5).
 */
function readTakeOutsOf(
  db: CrewReader,
  request: { takeOuts: Map<string, TakeOutRead> },
  into: Collector,
): Set<string> {
  const waiting = new Set<string>();
  for (const source of db.select().from(workSources).all()) {
    const intended = intendedLandingOf(db, source.id);
    if (intended?.kind === "take-out") {
      waiting.add(source.id);
      into.add({
        action: "settle_landing",
        sourceId: source.id,
        detail: `Take-out ${intended.id} moves ${intended.branch} from ${intended.fromCommit} to ${intended.toCommit}, and its outcome is not recorded. Repeat the take-out: it reads the branch once and moves it again, records the outcome, or names a moved branch.`,
        command: takeOutCommand(source.id, takeOutOf(intended).takeOut.planRevision),
      });
      continue;
    }
    const pending = pendingTakeOutsOf(db, source.id);
    const [first] = pending;
    if (first === undefined) {
      continue;
    }
    waiting.add(source.id);
    const read = request.takeOuts.get(source.id);
    const commits = pending.map((one) => one.landing.landedCommit).join(", ");
    // A plan that read no range is left to the command, which names the refusal.
    const move: Draft = {
      action: "take_out_commit",
      sourceId: source.id,
      detail: `The integration branch still holds the withdrawn commit(s) ${commits}. Each later commit that lands again passed the project gate, so the take-out moves the branch once without them. Until then no production work of the source starts.`,
      command: takeOutCommand(source.id, read?.planRevision ?? first.planRevision),
    };
    readGatedMove(
      db,
      {
        step: read?.gate ?? { status: "passed" },
        sourceId: source.id,
        waiter: { sourceId: source.id },
        passed: () => move,
        running: (gate) =>
          `Gate run ${gate.runIds.join(", ")} runs on ${gate.commit} of the rebuilt range of the take-out. Its runner wakes the Operator at the end.`,
        failed: () => move,
        pending: (gate) => ({
          action: "run_gate",
          sourceId: source.id,
          detail: `The take-out of the withdrawn commit(s) ${commits} rebuilds the branch, and ${gate.commit} on ${gate.parent} is the next commit of the rebuilt range with no gate run at its key.`,
          command: `operator gate run --source ${source.id}`,
        }),
      },
      into,
    );
  }
  return waiting;
}

/**
 * The landing of one code result whose every other gate of acceptance passed (ADR 0020). An
 * intent with no recorded outcome is settled first, by a repeat of the acceptance. Otherwise its
 * planned commit on the recorded tip passes the project gate, and only then is it accepted. The
 * candidate is the one a gate run of this submission on this tip recorded. A result that no
 * longer lands as it was reviewed, by a conflict or a changed patch that its plan read, or by a
 * failed or flaky candidate, goes to an integration cycle (ADR 0021).
 */
function readLanding(
  db: CrewReader,
  request: {
    assignmentId: string;
    reviewId: string;
    revision: number;
    sourceId: string;
    submissionId: string;
    broken: BrokenLanding | null;
    rewrite: RewriteRead | null;
    takeOutWaits: boolean;
  },
  into: Collector,
): void {
  const { sourceId, submissionId, broken, rewrite, takeOutWaits, ...subject } = request;
  const intended = intendedLandingOf(db, sourceId);
  if (intended !== null && intended.submissionId === submissionId) {
    into.add({
      ...subject,
      action: "settle_landing",
      detail: `Landing ${intended.id} moves ${intended.branch} from ${intended.fromCommit} to ${intended.toCommit}, and its outcome is not recorded. Repeat the acceptance: it reads the branch once and lands again, records the outcome, or names a moved branch.`,
      command: "operator work accept",
    });
    return;
  }
  // The take-out rebuilds the branch first, so this landing is planned on the new tip after it.
  if (takeOutWaits) {
    return;
  }
  const row = integrationBranchOf(db, sourceId);
  if (
    row !== null &&
    replacedLandingOf(db, { assignmentId: request.assignmentId, submissionId }) !== null
  ) {
    readRewrite(db, { ...subject, sourceId, broken, rewrite }, into);
    return;
  }
  if (row === null) {
    into.add({
      ...subject,
      action: "accept_assignment",
      detail: "The review reported and every finding carries a disposition.",
      command: "operator work accept",
    });
    return;
  }

  readGatedMove(
    db,
    {
      step: candidateGateOf(db, { sourceId, submissionId, tip: row.recordedTip }),
      sourceId,
      waiter: { assignmentId: request.assignmentId },
      passed: (gate) => ({
        ...subject,
        action: "accept_assignment",
        detail: `The review reported, and the planned commit ${gate.commit} on ${row.recordedTip} passed the project gate. Acceptance lands it on ${row.name}.`,
        command: "operator work accept",
      }),
      running: (gate) =>
        `Gate run ${gate.run.id} runs on the planned commit ${gate.run.commit}. Its runner wakes the Operator at the end.`,
      failed: (gate) => ({
        ...subject,
        action: "delegate_rework",
        detail: `The planned commit ${gate.commit} on ${row.recordedTip} is ${gate.status} in gate run ${gate.failed.map((one) => one.id).join(", ")}, so it does not land. Delegate an integration cycle, with the reason "integration": it carries the failed run, and it starts from the recorded tip of ${row.name}.`,
        command: INTEGRATION_COMMAND,
      }),
      pending: () =>
        broken === null
          ? {
              ...subject,
              action: "run_gate",
              detail: `The review reported. Acceptance lands the result on ${row.name} only after its planned commit on ${row.recordedTip} passes the project gate.`,
              command: `operator gate run --assignment ${request.assignmentId}`,
            }
          : {
              ...subject,
              action: "delegate_rework",
              detail:
                broken.cause === "conflict"
                  ? `Commit ${broken.commit} conflicts with the tip ${broken.tip} of ${broken.branch} in ${broken.paths.join(", ")}, so it does not land. Delegate an integration cycle, with the reason "integration": it starts from the recorded tip.`
                  : `Commit ${broken.commit} would land on the tip ${broken.tip} of ${broken.branch} as another patch, so it does not land as it was reviewed. Delegate an integration cycle, with the reason "integration": it starts from the recorded tip.`,
              command: INTEGRATION_COMMAND,
            },
    },
    into,
  );
}

/**
 * The step a correction of a landed commit owes (ADR 0020, ADR 0021). Its rebuilt range passes
 * the project gate in order, one commit at a time, and acceptance then moves the branch once. A
 * correction that conflicts, changes its patch, or fails the gate at its own place goes to an
 * integration cycle, which starts from the parent of the replaced commit.
 */
function readRewrite(
  db: CrewReader,
  request: {
    assignmentId: string;
    reviewId: string;
    revision: number;
    sourceId: string;
    broken: BrokenLanding | null;
    rewrite: RewriteRead | null;
  },
  into: Collector,
): void {
  const { sourceId, broken, rewrite, ...subject } = request;
  if (broken !== null) {
    into.add({
      ...subject,
      action: "delegate_rework",
      detail:
        broken.cause === "conflict"
          ? `The correction ${broken.commit} conflicts with ${broken.tip}, the parent of the commit it replaces on ${broken.branch}, in ${broken.paths.join(", ")}. Delegate an integration cycle, with the reason "integration": it starts from that parent.`
          : `The correction ${broken.commit} would land on ${broken.tip}, the parent of the commit it replaces on ${broken.branch}, as another patch. Delegate an integration cycle, with the reason "integration": it starts from that parent.`,
      command: INTEGRATION_COMMAND,
    });
    return;
  }
  // A plan that read no range is left to acceptance, which names the refusal.
  readGatedMove(
    db,
    {
      step: rewrite?.gate ?? { status: "passed" },
      sourceId,
      waiter: { assignmentId: request.assignmentId },
      passed: () => ({
        ...subject,
        action: "accept_assignment",
        detail: `The review reported, and each commit of the rebuilt range passed the project gate. Acceptance puts the correction in the place of ${rewrite?.replaced ?? "the landed commit"} and moves ${rewrite?.branch ?? "the branch"} once.`,
        command: "operator work accept",
      }),
      running: (gate) =>
        `Gate run ${gate.runIds.join(", ")} runs on ${gate.commit} of the rebuilt range. Its runner wakes the Operator at the end.`,
      failed: (gate) => ({
        ...subject,
        action: "delegate_rework",
        detail: `The correction ${gate.commit} on ${gate.parent} is ${gate.status} in gate run ${gate.runIds.join(", ")}, so it does not land. Delegate an integration cycle, with the reason "integration": it carries the failed run, and it starts from the parent of the replaced commit.`,
        command: INTEGRATION_COMMAND,
      }),
      pending: (gate) => ({
        ...subject,
        action: "run_gate",
        detail: `The review reported. The rebuilt range of the correction is gated in order, and ${gate.commit} on ${gate.parent} is the next commit with no gate run at its key.`,
        command: `operator gate run --assignment ${request.assignmentId}`,
      }),
    },
    into,
  );
}

type Step = { status: GateStatus };
type StepAt<S extends Step, K extends GateStatus> = Extract<S, { status: K }>;

function hasStatus<S extends Step, K extends GateStatus>(
  step: S,
  ...statuses: K[]
): step is StepAt<S, K> {
  return statuses.some((one) => one === step.status);
}

/** Who waits for a gate run in `crew next`: an assignment, or a source as a whole. */
type Waiter = { assignmentId: string } | { sourceId: string };

/**
 * One gate run of a source runs at a time. A move that starts one waits for the run in progress,
 * and the wait is recorded here.
 */
function waitsForRun(db: CrewReader, sourceId: string, waiter: Waiter, into: Collector): boolean {
  const running = runningRunOf(db, sourceId);
  if (running === null) {
    return false;
  }
  into.wait({
    wait: "gate_running",
    ...waiter,
    detail: `Gate run ${running.id} of source ${sourceId} runs first. One gate run of a source runs at a time.`,
  });
  return true;
}

/** A move behind the project gate, and what it owes in each state of its gate step. */
type GatedMove<S extends Step> = {
  step: S;
  sourceId: string;
  waiter: Waiter;
  /** The move itself. */
  passed: (step: StepAt<S, "passed">) => Draft;
  /** The detail of the wait for the run of the step. */
  running: (step: StepAt<S, "running">) => string;
  failed: (step: StepAt<S, "failed" | "flaky">) => Draft;
  pending: (step: StepAt<S, "pending">) => Draft;
};

/**
 * Turns one gate step into what `crew next` owes: a wait for its run, the move, the answer to a
 * failed or flaky key, or what a pending key owes. A gate run waits while another gate run of
 * the source runs.
 */
function readGatedMove<S extends Step>(db: CrewReader, gated: GatedMove<S>, into: Collector): void {
  const { step } = gated;
  if (hasStatus(step, "running")) {
    into.wait({ wait: "gate_running", ...gated.waiter, detail: gated.running(step) });
    return;
  }
  const draft = hasStatus(step, "passed")
    ? gated.passed(step)
    : hasStatus(step, "failed", "flaky")
      ? gated.failed(step)
      : hasStatus(step, "pending")
        ? gated.pending(step)
        : null;
  if (draft === null) {
    return;
  }
  if (draft.action === "run_gate" && waitsForRun(db, gated.sourceId, gated.waiter, into)) {
    return;
  }
  into.add(draft);
}

/** The command of an integration cycle. Its input names the reason and no revision (ADR 0020). */
const INTEGRATION_COMMAND = "operator work rework";

/** The tracker steps one accepted assignment still owes. */
function readTracker(
  db: CrewReader,
  assignmentId: string,
  revision: number,
  into: Collector,
): void {
  const bound = readBinding(db, assignmentId);
  if (bound.status !== "bound") {
    return;
  }
  // The steps of a code result wait for the recorded merge of the pull request that carries
  // its commit, so a ticket never closes before its commit reaches the target (ADR 0022).
  const code = mergeGateOf(db, assignmentId);
  if (code.status === "waiting") {
    return;
  }

  const held = trackerOperationsOf(db, assignmentId);
  for (const step of TRACKER_STEPS) {
    const operation = held.find((one) => one.step === step) ?? null;
    const read = TrackerStep.read({
      applicable: targetOf(bound.binding, step) !== null,
      operation,
    });
    if (read.actions.length > 0) {
      into.add(trackerDraftOf(db, { assignmentId, revision, step, operation, read, code }));
    }
  }
}

const RECORD_TRACKER = { action: "record_tracker", command: "operator tracker record" } as const;
const RECOVER_TRACKER = { action: "recover_tracker", command: "operator tracker recover" } as const;

/** What `crew next` offers for one tracker step that its state does not yet settle. */
function trackerDraftOf(
  db: CrewReader,
  request: {
    assignmentId: string;
    revision: number;
    step: TrackerStep;
    operation: TrackerOperationRow | null;
    read: ReturnType<typeof TrackerStep.read>;
    code: Exclude<MergeGate, { status: "waiting" }>;
  },
): Draft {
  const { step, operation, read, code } = request;
  // A step after the merge runs only under the publish approval that named it (D2).
  const unapproved = code.status === "merged" && !code.approved[step] && read.state !== "verified";
  // The map amendment of a code result also waits for an approval of its rendered text.
  const map =
    code.status === "merged" && step === "map_amendment" && operation !== null
      ? mapAmendmentOffer(db, operation)
      : { unsent: false, text: null };
  const text = unapproved ? null : map.text;
  const owed = !map.unsent && read.actions.includes("recover") ? RECOVER_TRACKER : RECORD_TRACKER;
  // A conflict and another write after an uncertain one are both a person's call.
  const person = read.actions.includes("user") || read.actions.includes("approved-write");
  const action: Draft = {
    action: owed.action,
    assignmentId: request.assignmentId,
    revision: request.revision,
    detail: text ?? `The ${step} step is ${read.state}.`,
    command: owed.command,
  };
  if (person || unapproved || text !== null) action.blocker = "approval_required";
  return action;
}

/**
 * Whether a removal of the checkout of one ended attempt may be offered. Accepted and withdrawn
 * work may go. A checkout that holds a commit of withdrawn work or a replaced commit holds
 * unlanded work, so only the person removes it, and `operator cleanup show` lists it (D3).
 */
function removableAfterClosure(
  db: CrewReader,
  request: { attemptId: string; state: string },
): boolean {
  return (
    (request.state === "accepted" || request.state === "withdrawn") &&
    unlandedCommitOf(db, { attemptId: request.attemptId, assignmentState: request.state }) === null
  );
}

/** The disposal one ended attempt still owes, and the hold that keeps its resources. */
function readCleanupOf(
  db: CrewReader,
  request: { attemptId: string; assignmentId: string; removable: boolean },
  into: Collector,
): void {
  const dispatch = readDispatchRow(db, request.attemptId);
  if (dispatch === null) {
    return;
  }

  const hold = heldRetention(db, request.attemptId);
  if (hold !== null) {
    into.wait({
      wait: "cleanup_held",
      assignmentId: request.assignmentId,
      attemptId: request.attemptId,
      agentName: dispatch.agentName,
      detail: `A retention hold keeps these resources: ${hold.reason}.`,
    });
    return;
  }

  const recorded = new Map<CleanupKind, CleanupState>(
    CLEANUP_KINDS.flatMap((kind) => {
      const row = readCleanup(db, { attemptId: request.attemptId, kind });
      return row === null ? [] : [[kind, cleanupRecordOf(row).state]];
    }),
  );
  const owed = Cleanup.owed(recorded, request.removable);
  if (owed === null) {
    return;
  }

  // A recorded state that a retry cannot clear names the person who settles it, so a stuck
  // cleanup stops this work instead of being offered on every reading.
  const step = OWED_STEPS[owed.kind];
  const draft: Draft = {
    action: owed.stuck === null ? step.action : "settle_cleanup",
    assignmentId: request.assignmentId,
    attemptId: request.attemptId,
    detail:
      owed.stuck === null
        ? step.detail
        : `The recorded ${owed.kind.replace("_", " ")} is ${owed.state}.`,
    command: step.command,
  };
  // Removing a checkout is never this session's decision, so it names a person either way.
  const blocker = owed.stuck ?? step.blocker;
  if (blocker !== null) draft.blocker = blocker;
  into.add(draft);
}

/** The next action each owed cleanup kind is offered as, when its recorded state is not stuck. */
const OWED_STEPS = {
  process_closure: {
    action: "close_process",
    command: "operator cleanup close",
    detail: "This Operative handed its work over and its process is still open.",
    blocker: null,
  },
  worktree_removal: {
    action: "remove_worktree",
    command: "operator cleanup remove",
    detail: "Removing this checkout needs its own approval against the inspected inputs.",
    blocker: "approval_required",
  },
} as const satisfies Record<
  CleanupKind,
  { action: NextActionName; command: string; detail: string; blocker: NextBlocker | null }
>;

/** The readiness verdict, reported as the action it is when this selection is not ready. */
function readReadiness(readiness: Readiness, into: Collector): void {
  if (readiness.ready) {
    return;
  }

  into.add({
    action: "prove_readiness",
    blocker: "readiness_blocked",
    detail: readiness.detail,
    command: "operator setup readiness",
  });
}

/** An empty crew, so a project with no state answers in the shape every other reading uses. */
function emptyFrontier(capacity: Capacity): Frontier {
  return {
    capacity: {
      ...capacity,
      active: { total: 0, production: 0, review: 0 },
      freeSlots: capacity.limit,
    },
    dispatchable: [],
    blocked: [],
    active: [],
    planning: [],
    accepted: [],
    withdrawn: [],
    questions: [],
  };
}

/** The collected schedule, with the verdict and the blockers that it gives. */
function scheduleOf(
  into: Collector,
  read: { ownership: CrewNext["ownership"]; frontier: Frontier },
): CrewNext {
  const actions = into.actions();
  const waits = into.waits();
  return {
    status: "reported",
    ownership: read.ownership,
    capacity: read.frontier.capacity,
    actions,
    waits,
    frontier: read.frontier,
    verdict: verdictOf({ actions, waits }),
    blockers: blockersOf(actions),
  };
}

/**
 * What a project that holds no crew state may do next.
 * It answers in the same shape as a project that holds one, because a session reads one
 * contract and not two.
 */
export function calculateUnowned(request: { capacity: Capacity; readiness: Readiness }): CrewNext {
  const into = collector();
  readReadiness(request.readiness, into);
  into.add({
    action: "own_crew",
    detail: "This project holds no crew state, so nothing is registered yet.",
    command: "operator crew own",
  });

  return scheduleOf(into, { ownership: null, frontier: emptyFrontier(request.capacity) });
}

/**
 * Reads everything one crew may do next and writes nothing.
 * The frontier stays the only rule for what may start, so this adds no order of its own to the
 * work it offers: it reports the frontier's order and the steps the recorded state still owes.
 * Each reader reads the recorded states of one kind of subject, in this order: the attempts, the
 * questions, the take-outs, the assignments, the sources, and then the frontier. A wait keeps the
 * order it is read in, and so do actions of one rank, so this order is part of the report.
 */
export function calculateNext(
  db: CrewReader,
  request: {
    capacity: Capacity;
    readiness: Readiness;
    // The landings whose plan read a conflict or a changed patch, by submission.
    broken: Map<string, BrokenLanding>;
    // The rebuilt range of each correction of a landed commit, by submission.
    rewrites: Map<string, RewriteRead>;
    // The take-out of each source whose branch still holds a withdrawn commit, by source.
    takeOuts: Map<string, TakeOutRead>;
  },
): CrewNext {
  const frontier = calculateFrontier(db, request.capacity);
  const ownership = currentOwnership(db);
  const into = collector();

  readReadiness(request.readiness, into);
  const unsettled = readAttempts(db, ownership, into);
  readQuestions(db, unsettled, into);
  const takeOutWaits = readTakeOutsOf(db, { takeOuts: request.takeOuts }, into);
  const paused = openPauses(db);
  const steps = { paused, broken: request.broken, rewrites: request.rewrites, takeOutWaits };
  for (const row of allAssignments(db)) {
    readAssignmentSteps(db, row, steps, into);
  }
  readSourceSteps(db, into);
  readFrontier(db, { frontier, paused }, into);

  return scheduleOf(into, {
    ownership:
      ownership === null
        ? null
        : {
            ownerLabel: ownership.ownerLabel,
            acquiredAt: ownership.acquiredAt,
            revision: ownership.revision,
          },
    frontier,
  });
}

type Ownership = ReturnType<typeof currentOwnership>;
type AttemptRow = typeof attempts.$inferSelect;
type AssignmentRow = typeof assignments.$inferSelect;

/**
 * Reads each attempt, oldest first, and gives the attempts that hold an operation with no proved
 * outcome. The base gate of a source is reported once, however many of its attempts wait for it.
 */
function readAttempts(db: CrewReader, ownership: Ownership, into: Collector): Set<string> {
  const held = allAttempts(db).map((attempt) => ({
    attempt,
    unsettled: unsettledOperations(liveOperations(db, attempt.id)).map((one) => one.kind),
  }));
  const gateSources = new Set<string>();
  for (const one of held) {
    readAttempt(db, { ...one, ownership, gateSources }, into);
  }
  return new Set(held.flatMap((one) => (one.unsettled.length === 0 ? [] : [one.attempt.id])));
}

/**
 * What one attempt owes in its recorded state. An active attempt owes its launch, or it waits for
 * its Operative. A replaced attempt handed its checkout and its agent name to the replacement, so
 * the disposal of those resources belongs to the attempt that holds them now.
 */
function readAttempt(
  db: CrewReader,
  request: {
    attempt: AttemptRow;
    unsettled: string[];
    ownership: Ownership;
    gateSources: Set<string>;
  },
  into: Collector,
): void {
  const { attempt, ownership } = request;
  const assignment = readAssignment(db, attempt.assignmentId);
  if (assignment === null) {
    return;
  }

  if (attempt.state === "active") {
    const first = assignment.kind === "production" && isFirstCodeDispatch(db, assignment.sourceId);
    readActiveAttempt(
      db,
      {
        attemptId: attempt.id,
        assignmentId: attempt.assignmentId,
        ownedByCurrent: ownership !== null && ownership.token === attempt.ownerToken,
        unsettled: request.unsettled,
        baseGate: first
          ? {
              sourceId: assignment.sourceId,
              gate: baseGateOf(db, assignment.sourceId),
              reported: request.gateSources,
            }
          : null,
        integration: tipStartOf(db, assignment),
        branchHead: branchHeadOf(db, assignment.id),
        submitted: submittedStartOf(db, assignment),
      },
      into,
    );
    return;
  }

  if (attempt.state === "submitted" || attempt.state === "accepted") {
    readCleanupOf(
      db,
      {
        attemptId: attempt.id,
        assignmentId: attempt.assignmentId,
        removable: removableAfterClosure(db, { attemptId: attempt.id, state: assignment.state }),
      },
      into,
    );
  }
}

/** The assignments of one crew, in the order of their ids. */
function allAssignments(db: CrewReader): AssignmentRow[] {
  return db
    .select()
    .from(assignments)
    .all()
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/**
 * The steps one assignment owes in its recorded state. A withdrawal is terminal and closed every
 * open record of its work, so it owes nothing. Work that read an invalid result waits for the
 * corrected one, so it is reported as the wait it is rather than left out of the reading.
 */
function readAssignmentSteps(
  db: CrewReader,
  row: AssignmentRow,
  request: {
    paused: Map<string, string[]>;
    broken: Map<string, BrokenLanding>;
    rewrites: Map<string, RewriteRead>;
    takeOutWaits: Set<string>;
  },
  into: Collector,
): void {
  if (row.state === "withdrawn") {
    return;
  }
  for (const direction of undirected(db, row.id)) {
    const record = directionRecordOf(direction);
    into.add({
      action: "direct_limit",
      assignmentId: row.id,
      revision: record.revision,
      blocker: "direction_required",
      detail: `${record.limitKind} reached ${record.limitValue}. Only the user can direct it.`,
      command: "operator approval grant",
    });
  }

  const invalid = request.paused.get(row.id);
  if (invalid !== undefined) {
    into.wait({
      wait: "input_invalidated",
      assignmentId: row.id,
      detail: `This work read a result a defect was found in: ${invalid.join(", ")}.`,
    });
    return;
  }

  if (row.state === "awaiting-review") {
    readReview(
      db,
      {
        assignmentId: row.id,
        revision: row.revision,
        sourceId: row.sourceId,
        broken: request.broken,
        rewrites: request.rewrites,
        takeOutWaits: request.takeOutWaits,
      },
      into,
    );
  }
  if (isReview(row.kind)) {
    readBranchReview(db, row, into);
  }
  if (row.state === "accepted") {
    readTracker(db, row.id, row.revision, into);
  }
}

/**
 * The steps of the assignment of one reviewer. A branch review gates the publish, so each of its
 * findings is answered whatever state its own assignment is in, and a corrected one invalidates
 * its target in the same answer. A review assignment holds no result of its own, so it is
 * accepted once it reported.
 */
function readBranchReview(db: CrewReader, row: AssignmentRow, into: Collector): void {
  const review = reviewOfAssignment(db, row.id);
  if (review === null) {
    return;
  }
  const open = review.snapshotId === null ? [] : undisposed(findingsOf(db, review.id));
  if (open.length > 0) {
    into.add({
      action: "dispose_findings",
      assignmentId: row.id,
      reviewId: review.id,
      revision: row.revision,
      detail: `${open.length} branch finding(s) carry no disposition. A corrected one names its one target assignment.`,
      command: "operator review dispose",
    });
  }
  if (row.state === "claimed" && review.state === "reported") {
    into.add({
      action: "accept_assignment",
      assignmentId: row.id,
      reviewId: review.id,
      revision: row.revision,
      detail: "This reviewer reported both axes, so its own assignment can be accepted.",
      command: "operator work accept",
    });
  }
}

/**
 * The steps each source owes: first its rebase, then its publish. Each one reads every source, so
 * the waits of all rebases come before the waits of all publishes.
 */
function readSourceSteps(db: CrewReader, into: Collector): void {
  readRebase(db, into);
  readPublish(db, into);
}

/**
 * The work the frontier offers. Planning work is never dispatched. Once its dependencies land,
 * the crew prepares its record and the Operator records the acceptance.
 */
function readFrontier(
  db: CrewReader,
  request: { frontier: Frontier; paused: Map<string, string[]> },
  into: Collector,
): void {
  for (const entry of request.frontier.planning) {
    if (
      request.paused.has(entry.assignmentId) ||
      unmetDependencies(db, entry.assignmentId).length > 0
    ) {
      continue;
    }

    into.add({
      action: "resolve_planning",
      assignmentId: entry.assignmentId,
      revision: entry.revision,
      planningRecords: dependencyRecords(db, entry.assignmentId),
      detail:
        entry.state === "invalidated"
          ? "The planning decision was invalidated, so the crew prepares it again with a new planning record."
          : "Planning work is registered so dependencies resolve. The crew prepares its planning record.",
      command: "operator work accept",
    });
  }

  for (const entry of request.frontier.dispatchable) {
    into.add({
      action: "claim_assignment",
      assignmentId: entry.assignmentId,
      revision: entry.revision,
      detail: `${entry.kind} work the frontier offers now.`,
      command: "operator work claim",
    });
  }
}
