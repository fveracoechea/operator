import { Err, Ok, fromThrowable, type Result } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { createDatabase, databaseExists } from "./creation.ts";
import { openDatabase } from "./database.ts";
import { compatibility } from "./compatibility.ts";
import { qualifyStateFailure, type StateFailure } from "./failures.ts";
import {
  registerProject,
  lookupProject,
  listProjects,
  moveProject,
  removeProject,
  type RegisteredProject,
} from "./projects.ts";
import { ensureProjectDirectory, finishProjectRemoval } from "./project-files.ts";
import {
  registerSource,
  readSources,
  resetSource,
  endAssignments,
  pruneSource,
  type StoredSource,
  type Supervisor,
} from "./sources.ts";

import {
  reserveLaunch,
  updateLaunch,
  launchNames,
  observePane,
  beginPreparation,
  finishPreparation,
  readPreparation,
  renewLaunch,
  renewPreparation,
  type LaunchReservation,
} from "./launches.ts";
import {
  worktreeOwners,
  checkParkedMergeOwner,
  associatePullRequest,
  recordPullRequestWait,
  renewPullRequestWait,
  recordPullRequestMerge,
  renewPullRequestRelay,
} from "./pull-requests.ts";
import {
  claimHandoff,
  endInternalReview,
  failHandoff,
  finishImplementer,
  recordInternalReviewRound,
  renewHandoff,
  startHandoff,
} from "./internal-reviews.ts";
import { leaseRenewMs } from "./leases.ts";
import {
  admitDelivery,
  readDelivery,
  recoverDelivery,
  changeDelivery,
  recordDeliveryValidation,
} from "./deliveries.ts";
import { checkAdoption, type AdoptionTarget } from "./adoptions.ts";
import { prReadinessSchema, storedPrReadinessSchema } from "./pr-readiness.ts";
import {
  prParkingSchema,
  recordPullRequestQueue,
  refusePullRequestQueue,
  parkPullRequest,
  completeParking,
  resumeParkedPullRequest,
  claimParkedRead,
  finishParkedRead,
} from "./pr-parking.ts";
import { recoverInternalReview, readInternalReviewRecovery } from "./internal-review-recovery.ts";
import { readContinuation, type HandoffContinuation } from "./handoff-continuation.ts";
import { claimCleanup, advanceCleanup, renewCleanup, startCleanup } from "./cleanups.ts";
import {
  acknowledgeCoordinationWaits,
  changeCoordinationWait,
  coordinationSessionScope,
  finishCoordinationWait,
  readCoordinationWait,
  readSupervision,
  readSupervisor,
  renewCoordinationWait,
  startCoordinationWait,
  takeOverSource,
  type CoordinationScope,
  type SetChange,
} from "./coordination-waits.ts";

import { changeReport, readReport, type ReportTarget } from "./reports.ts";
import { changeQuestion, readQuestion } from "./questions.ts";
import { changeMessage, readMessage } from "./messages.ts";
import { changeObligation, readObligations } from "./obligations.ts";
import {
  changeReviewRequest,
  readReviewRequest,
  readReviewRequests,
  renewReviewLease,
  type ReviewChange,
  type ReviewSnapshot,
} from "./review-requests.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;

type Client = ReturnType<typeof openDatabase>;

/** Open the existing database for one action. A connection never leaves this owner. */
function open<T, E>(paths: Paths, readonly: boolean, action: (client: Client) => Result<T, E>) {
  return fromThrowable(
    (): Result<T, E> => {
      using client = openDatabase(paths.database, readonly);
      return action(client);
    },
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((result) => result);
}

/** Missing state refuses with its own detail, because only registration may create it. */
function existing(paths: Paths, missing: string) {
  return fromThrowable(
    (): Result<void, StateFailure> =>
      databaseExists(paths.database)
        ? Ok(undefined)
        : Err({
            reason: "state_missing",
            detail: missing,
            next: {
              command: "operator project register",
              why: "Register a project explicitly to initialize device state.",
            },
            state: { databaseExists: false },
          }),
    (cause, defect) =>
      cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
  )().flatMap((result) => result);
}

const beforeOperation = "Register the project explicitly before this operation.";

function reading<T, E>(
  paths: Paths,
  action: (client: Client) => Result<T, E>,
  missing = beforeOperation,
) {
  // Stryker disable next-line BooleanLiteral: equivalent: a read action writes nothing, so query_only refuses nothing it does
  return existing(paths, missing).flatMap(() => open(paths, true, action));
}

function writing<T, E>(
  paths: Paths,
  action: (client: Client) => Result<T, E>,
  missing = beforeOperation,
) {
  return existing(paths, missing).flatMap(() => open(paths, false, action));
}

function hold(renew: () => void) {
  const timer = setInterval(renew, leaseRenewMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Only explicit registration may create state. Connections never leave this owner. */
export const DeviceState = {
  recordDeliveryValidation(paths: Paths, input: Parameters<typeof recordDeliveryValidation>[1]) {
    return writing(paths, (client) => recordDeliveryValidation(client, input));
  },
  admitDelivery(paths: Paths, input: Parameters<typeof admitDelivery>[1]) {
    return writing(paths, (client) => admitDelivery(client, input, true));
  },
  readDelivery(paths: Paths, launchId: string) {
    return reading(paths, (client) => readDelivery(client, launchId));
  },
  recoverDelivery(paths: Paths, input: Parameters<typeof recoverDelivery>[1], id: string) {
    return writing(paths, (client) => recoverDelivery(client, input, id));
  },
  changeDelivery(paths: Paths, id: string, change: Parameters<typeof changeDelivery>[2]) {
    return writing(paths, (client) => changeDelivery(client, id, change));
  },
  prParkingSchema() {
    return prParkingSchema;
  },
  recordPullRequestQueue(
    paths: Paths,
    launchId: string,
    head: string,
    actor?: Parameters<typeof recordPullRequestQueue>[3],
  ) {
    return writing(paths, (client) => recordPullRequestQueue(client, launchId, head, actor));
  },

  refusePullRequestQueue(paths: Paths, launchId: string, head: string, attempt: string) {
    return writing(paths, (client) => refusePullRequestQueue(client, launchId, head, attempt));
  },
  parkPullRequest(paths: Paths, launchId: string, input: Parameters<typeof parkPullRequest>[2]) {
    return writing(paths, (client) => parkPullRequest(client, launchId, input));
  },
  completeParking(
    paths: Paths,
    target: Parameters<typeof completeParking>[1],
    continuation?: HandoffContinuation,
  ) {
    return writing(paths, (client) => completeParking(client, target, continuation));
  },
  resumeParkedPullRequest(
    paths: Paths,
    target: Parameters<typeof resumeParkedPullRequest>[1],
    fillKind?: string,
    supervisor?: Parameters<typeof resumeParkedPullRequest>[3],
  ) {
    return writing(paths, (client) =>
      resumeParkedPullRequest(client, target, fillKind, supervisor),
    );
  },
  claimParkedRead(paths: Paths) {
    return writing(paths, (client) => claimParkedRead(client, Date.now()));
  },
  finishParkedRead(paths: Paths, at: string, updates: Parameters<typeof finishParkedRead>[2]) {
    return writing(paths, (client) => finishParkedRead(client, at, updates));
  },
  prReadinessSchema() {
    return prReadinessSchema;
  },
  storedPrReadinessSchema() {
    return storedPrReadinessSchema;
  },
  checkCompatibility(paths: Paths, firstRegistration = false) {
    return compatibility(paths, firstRegistration);
  },
  registerSource(
    paths: Paths,
    checkout: string,
    source: StoredSource,
    assignments: Parameters<typeof registerSource>[3],
  ) {
    return writing(
      paths,
      (client) => registerSource(client, checkout, source, assignments),
      "Register the project explicitly before registering a source.",
    );
  },
  reserveLaunch(
    paths: Paths,
    checkout: string,
    repository: string,
    launch: LaunchReservation,
    maxRunning?: number,
    supervisor?: Supervisor,
    continuation?: HandoffContinuation,
    fillKind?: string,
    adoption?: Pick<AdoptionTarget, "number">,
  ) {
    return writing(paths, (client) =>
      reserveLaunch(
        client,
        checkout,
        repository,
        launch,
        maxRunning,
        supervisor,
        continuation,
        fillKind,
        adoption,
      ),
    );
  },
  checkAdoption(paths: Paths, target: AdoptionTarget) {
    return reading(paths, (client) => checkAdoption(client, target));
  },
  updateLaunch(paths: Paths, id: string, change: Parameters<typeof updateLaunch>[2]) {
    return writing(paths, (client) => updateLaunch(client, id, change));
  },
  /** Apply one report transition that the caller's rule decides from facts read in the same transaction. */
  changeReport<E extends { reason: string; detail: string }>(
    paths: Paths,
    target: ReportTarget,
    decide: Parameters<typeof changeReport<E>>[2],
  ) {
    return writing(paths, (client) => changeReport(client, target, decide));
  },
  readReport(paths: Paths, target: ReportTarget) {
    return reading(paths, (client) => readReport(client, target));
  },
  /** Apply one question transition that the caller's rule decides from facts read in the same transaction. */
  changeQuestion<E extends { reason: string; detail: string }>(
    paths: Paths,
    target: ReportTarget,
    key: string,
    decide: Parameters<typeof changeQuestion<E>>[3],
  ) {
    return writing(paths, (client) => changeQuestion(client, target, key, decide));
  },
  readQuestion(paths: Paths, target: ReportTarget, key: string) {
    return reading(paths, (client) => readQuestion(client, target, key));
  },
  /** Apply one steering message transition that the caller's rule decides from facts read in the same transaction. */
  changeMessage<E extends { reason: string; detail: string }>(
    paths: Paths,
    target: ReportTarget,
    key: string,
    decide: Parameters<typeof changeMessage<E>>[3],
  ) {
    return writing(paths, (client) => changeMessage(client, target, key, decide));
  },
  readMessage(paths: Paths, target: ReportTarget, key: string) {
    return reading(paths, (client) => readMessage(client, target, key));
  },
  /** Apply one obligation change that the caller's rule decides from facts read in the same transaction. */
  changeObligation<E extends { reason: string; detail: string }>(
    paths: Paths,
    target: Parameters<typeof readObligations>[1],
    key: string,
    decide: Parameters<typeof changeObligation<E>>[3],
  ) {
    return writing(paths, (client) => changeObligation(client, target, key, decide));
  },
  readObligations(paths: Paths, target: Parameters<typeof readObligations>[1]) {
    return reading(paths, (client) => readObligations(client, target));
  },
  launchNames(paths: Paths) {
    return reading(paths, (client) => launchNames(client));
  },
  observePane(paths: Paths, input: Parameters<typeof observePane>[1]) {
    return writing(paths, (client) => observePane(client, input));
  },
  beginPreparation(paths: Paths, path: string, repository: string) {
    return writing(paths, (client) => beginPreparation(client, path, repository));
  },
  finishPreparation(paths: Paths, path: string, outcome: Parameters<typeof finishPreparation>[2]) {
    return writing(paths, (client) => finishPreparation(client, path, outcome));
  },
  readPreparation(paths: Paths, path: string) {
    return reading(paths, (client) => readPreparation(client, path));
  },
  /** Renew this process's lease on a starting launch until the returned stop runs. */
  holdLaunch(paths: Paths, id: string) {
    return hold(() => writing(paths, (client) => renewLaunch(client, id)));
  },
  /** Renew this process's lease on a running preparation until the returned stop runs. */
  holdPreparation(paths: Paths, path: string) {
    return hold(() => writing(paths, (client) => renewPreparation(client, path)));
  },
  worktreeOwners(paths: Paths) {
    return reading(paths, (client) => worktreeOwners(client));
  },
  checkParkedMergeOwner(paths: Paths, launchId: string, head: string) {
    return reading(paths, (client) => checkParkedMergeOwner(client, launchId, head));
  },
  /**
   * With `review`, the association also queues the optional assignment-origin review request.
   * With `internalReview`, it records the internal review and its pending handoff.
   */
  associatePullRequest(
    paths: Paths,
    launchId: string,
    pr: Parameters<typeof associatePullRequest>[2],
    review = false,
    internalReview = false,
  ) {
    return writing(paths, (client) =>
      associatePullRequest(client, launchId, pr, review, internalReview),
    );
  },
  /** Adoption enters its selected kind directly, without an outgoing-worker handoff. */
  adoptPullRequest(
    paths: Paths,
    launchId: string,
    pr: Parameters<typeof associatePullRequest>[2],
    entry: { internalReview: boolean; assignmentReview: boolean },
  ) {
    return writing(paths, (client) =>
      associatePullRequest(
        client,
        launchId,
        pr,
        entry.assignmentReview && !entry.internalReview,
        entry.internalReview,
        true,
      ),
    );
  },
  recoverInternalReview(paths: Paths, input: Parameters<typeof recoverInternalReview>[1]) {
    return writing(paths, (client) => recoverInternalReview(client, input));
  },
  readInternalReviewRecovery(
    paths: Paths,
    repository: string,
    sourceId: string,
    assignment: string,
  ) {
    return reading(paths, (client) =>
      readInternalReviewRecovery(client, repository, sourceId, assignment),
    );
  },
  /** `afterPid` is the associating process, whose hold the handoff it started takes over. */
  claimHandoff(
    paths: Paths,
    repository: string,
    sourceId: string,
    assignment: string,
    afterPid: number | null,
    continuation?: HandoffContinuation,
  ) {
    return writing(paths, (client) =>
      claimHandoff(client, repository, sourceId, assignment, afterPid, continuation),
    );
  },
  startHandoff(paths: Paths, sourceId: string, assignment: string, pid: number) {
    return writing(paths, (client) => startHandoff(client, sourceId, assignment, pid));
  },
  failHandoff(
    paths: Paths,
    sourceId: string,
    assignment: string,
    detail: string,
    continuation?: HandoffContinuation,
  ) {
    return writing(paths, (client) =>
      failHandoff(client, sourceId, assignment, detail, continuation),
    );
  },
  /** Renew this process's lease on a running handoff until the returned stop runs. */
  holdHandoff(
    paths: Paths,
    sourceId: string,
    assignment: string,
    continuation?: HandoffContinuation,
  ) {
    return hold(() =>
      writing(paths, (client) => renewHandoff(client, sourceId, assignment, continuation)),
    );
  },
  /** Ends the implementer launch whose pane the handoff closed. */
  finishImplementer(paths: Paths, launchId: string, continuation?: HandoffContinuation) {
    return writing(paths, (client) => finishImplementer(client, launchId, continuation));
  },
  readHandoffContinuation(
    paths: Paths,
    target: Parameters<typeof readContinuation>[1],
    context: Parameters<typeof readContinuation>[2],
    publishingPid: number,
  ) {
    return reading(paths, (client) => readContinuation(client, target, context, publishingPid));
  },
  /** Revalidates and renews the current continuation in one write transaction before its effect. */
  checkHandoffContinuation(paths: Paths, continuation: HandoffContinuation) {
    return writing(paths, (client) =>
      renewHandoff(client, continuation.sourceId, continuation.assignment, continuation),
    );
  },
  /** Ends a running internal review ready or skipped, and queues the assignment reviewer with `queueReview`. */
  endInternalReview(
    paths: Paths,
    target: Parameters<typeof endInternalReview>[1],
    end: Parameters<typeof endInternalReview>[2],
    queueReview: boolean,
  ) {
    return writing(paths, (client) => endInternalReview(client, target, end, queueReview));
  },
  /** Records one internal review round when the caller's rule permits it on the facts read in the write. */
  recordInternalReviewRound<E extends { reason: string; detail: string }>(
    paths: Paths,
    launchId: string,
    decide: Parameters<typeof recordInternalReviewRound<E>>[2],
  ) {
    return writing(paths, (client) => recordInternalReviewRound(client, launchId, decide));
  },
  /** Apply one review-request transition that the caller's rule decides from the active request. */
  changeReviewRequest<E>(
    paths: Paths,
    target: { repository: string; number: number; id?: string },
    decide: (current: ReviewSnapshot) => Result<ReviewChange, E>,
  ) {
    return writing(paths, (client) => changeReviewRequest(client, target, decide));
  },
  readReviewRequest(paths: Paths, target: { repository: string; number: number; id?: string }) {
    return reading(paths, (client) => readReviewRequest(client, target));
  },
  readReviewRequests(paths: Paths) {
    return reading(paths, (client) => readReviewRequests(client));
  },
  /** Renew this process's lease on a reviewer start, post, move, or cleanup until the stop runs. */
  holdReviewRequest(paths: Paths, id: string) {
    return hold(() => writing(paths, (client) => renewReviewLease(client, id)));
  },
  recordPullRequestWait(
    paths: Paths,
    launchId: string,
    decide: Parameters<typeof recordPullRequestWait>[2],
  ) {
    return writing(paths, (client) => recordPullRequestWait(client, launchId, decide));
  },
  /** Renew this process's lease on a running PR wait until the returned stop runs. */
  holdPullRequestWait(paths: Paths, sourceId: string, assignment: string) {
    return hold(() =>
      writing(paths, (client) => renewPullRequestWait(client, sourceId, assignment)),
    );
  },
  recordPullRequestMerge(
    paths: Paths,
    launchId: string,
    merge: Parameters<typeof recordPullRequestMerge>[2],
    sourceState: Parameters<typeof recordPullRequestMerge>[3],
  ) {
    return writing(paths, (client) => recordPullRequestMerge(client, launchId, merge, sourceState));
  },
  claimCleanup(paths: Paths, repository: string, sourceId: string, assignment: string) {
    return writing(paths, (client) => claimCleanup(client, repository, sourceId, assignment));
  },
  startCleanup(paths: Paths, sourceId: string, assignment: string, pid: number) {
    return writing(paths, (client) => startCleanup(client, sourceId, assignment, pid));
  },
  advanceCleanup(
    paths: Paths,
    sourceId: string,
    assignment: string,
    change: Parameters<typeof advanceCleanup>[3],
  ) {
    return writing(paths, (client) => advanceCleanup(client, sourceId, assignment, change));
  },
  /** Renew this process's lease on a running cleanup until the returned stop runs. */
  holdCleanup(paths: Paths, sourceId: string, assignment: string) {
    return hold(() => writing(paths, (client) => renewCleanup(client, sourceId, assignment)));
  },
  /** Record this process as the scope's running coordination wait and read its last returned set. */
  startCoordinationWait(paths: Paths, target: CoordinationScope, supervisor: Supervisor) {
    return writing(paths, (client) => startCoordinationWait(client, target, supervisor));
  },
  /** Merge the returned set into the scope's stored set and end this process's wait. */
  finishCoordinationWait(paths: Paths, target: CoordinationScope, change: SetChange) {
    return writing(paths, (client) => finishCoordinationWait(client, target, change));
  },
  /** The scope's stored set, which an acknowledgement can change while its wait runs. */
  readCoordinationWait(paths: Paths, target: CoordinationScope) {
    return reading(paths, (client) => readCoordinationWait(client, target));
  },
  /** Rewrite the scope's stored set, if it has one, under the writer reservation. */
  changeCoordinationWait(
    paths: Paths,
    target: CoordinationScope,
    change: SetChange,
    options?: { initialize?: boolean },
  ) {
    return writing(paths, (client) => changeCoordinationWait(client, target, change, options));
  },
  /** Rewrite the stored set of every wait that the session ran, after a change it made. */
  acknowledgeCoordinationWaits(paths: Paths, session: string, change: SetChange) {
    return writing(paths, (client) => acknowledgeCoordinationWaits(client, session, change));
  },
  /** The scope of a session's wait without a source, which covers every source it supervises. */
  coordinationSessionScope(session: string) {
    return coordinationSessionScope(session);
  },
  /** The sources that an agent session supervises, and whether a wait from it covers each. */
  readSupervision(paths: Paths, session: string) {
    return reading(paths, (client) => readSupervision(client, session));
  },
  /** The pane and session that supervise a source of the project. */
  readSupervisor(paths: Paths, repository: string, sourceId: string) {
    return reading(paths, (client) => readSupervisor(client, repository, sourceId));
  },
  /** Make the caller a source's supervisor and return the earlier one. Only a person orders it. */
  takeOverSource(paths: Paths, repository: string, sourceId: string, supervisor: Supervisor) {
    return writing(paths, (client) => takeOverSource(client, repository, sourceId, supervisor));
  },
  /** Renew this process's lease on a running coordination wait until the returned stop runs. */
  holdCoordinationWait(paths: Paths, target: CoordinationScope) {
    return hold(() => writing(paths, (client) => renewCoordinationWait(client, target)));
  },
  /** Renew this process's claim on a PR relay until the returned stop runs. */
  holdPullRequestRelay(paths: Paths, sourceId: string, assignment: string) {
    return hold(() =>
      writing(paths, (client) => renewPullRequestRelay(client, sourceId, assignment)),
    );
  },
  /** End one open source with the caller's rule, applied to facts read under the writer reservation. */
  resetSource<E extends { reason: string; detail: string }>(
    paths: Paths,
    target: Parameters<typeof resetSource>[1],
    decide: Parameters<typeof resetSource<E>>[2],
  ) {
    return writing(paths, (client) => resetSource(client, target, decide));
  },
  /** End selected assignments and retain their resources under one writer reservation. */
  endAssignments<E extends { reason: string; detail: string }>(
    paths: Paths,
    target: Parameters<typeof endAssignments>[1],
    decide: Parameters<typeof endAssignments<E>>[2],
  ) {
    return writing(paths, (client) => endAssignments(client, target, decide));
  },
  /** Delete one ended source's files and records when the caller's rule permits it. */
  pruneSource(
    paths: Paths,
    target: Parameters<typeof pruneSource>[2],
    decide: Parameters<typeof pruneSource>[3],
  ) {
    return writing(paths, (client) => pruneSource(client, paths, target, decide));
  },
  readSources(paths: Paths, repository: string, sourceId?: string) {
    return reading(
      paths,
      (client) => readSources(client, repository, sourceId),
      "Register the project explicitly before reading sources.",
    );
  },
  registerProject(paths: Paths, project: RegisteredProject) {
    return fromThrowable(
      () => databaseExists(paths.database),
      (cause, defect) =>
        cause instanceof Error ? qualifyStateFailure(cause, defect) : defect(cause),
    )()
      .flatMap((exists) =>
        // Stryker disable next-line ConditionalExpression: equivalent: creation beside an existing database loses the link race and registers in that database
        exists
          ? open(paths, false, (client) => registerProject(client, project))
          : createDatabase(paths, project),
      )
      .flatMap((outcome) =>
        open(paths, false, (client) =>
          ensureProjectDirectory(client, paths, outcome.data).map(() => outcome),
        ),
      );
  },
  lookupProject(paths: Paths, checkout: string, repositories: string[]) {
    return reading(
      paths,
      (client) => lookupProject(client, checkout, repositories),
      "The device database is missing. Run operator project register explicitly in the controlling checkout.",
    );
  },
  listProjects(paths: Paths) {
    return reading(paths, (client) => listProjects(client));
  },
  moveProject(paths: Paths, repository: string, checkout: string) {
    return writing(paths, (client) => moveProject(client, repository, checkout));
  },
  removeProject(paths: Paths, repository: string) {
    const removed = writing(paths, (client) => removeProject(client, repository));
    if (removed.tag !== "Ok") return removed;
    const cleaned = open(paths, false, (client) => finishProjectRemoval(client, paths, repository));
    if (cleaned.tag === "Err")
      return Err({
        reason: "project_cleanup_pending" as const,
        next: {
          decider: "super-agent" as const,
          question:
            "How should the pending project removal failure be corrected while preserving its remaining state?",
        },
        detail: `Project records were removed, but file cleanup is still pending. Repeat project remove ${repository} --person-instructed after resolving the path or I/O failure. ${cleaned.error.detail}`,
      });
    return cleaned.map(() => ({ reason: "project_removed" as const, data: { repository } }));
  },
};
