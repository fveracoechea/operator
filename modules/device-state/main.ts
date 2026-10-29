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
  pruneSource,
  type SourceRow as StoredSource,
  type AssignmentRow as StoredAssignment,
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
  type LaunchRow,
} from "./launches.ts";
import {
  worktreeOwners,
  associatePullRequest,
  recordPullRequestWait,
  renewPullRequestWait,
  recordPullRequestMerge,
  renewPullRequestRelay,
} from "./pull-requests.ts";
import { leaseRenewMs } from "./leases.ts";
import { claimCleanup, advanceCleanup, renewCleanup, startCleanup } from "./cleanups.ts";

import { changeReport, readReport, type ReportTarget } from "./reports.ts";
import {
  changeReviewRequest,
  readReviewRequest,
  readReviewRequests,
  renewReviewLease,
  type ReviewChange,
  type ReviewSnapshot,
} from "./review-requests.ts";
import { acknowledgeSlackEffect, ingestSlack, readSlack, startSlackWatch } from "./slack.ts";

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
        : Err({ reason: "state_missing", detail: missing }),
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
  checkCompatibility(paths: Paths, firstRegistration = false) {
    return compatibility(paths, firstRegistration);
  },
  registerSource(
    paths: Paths,
    checkout: string,
    source: StoredSource,
    assignments: StoredAssignment[],
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
    launch: Omit<LaunchRow, "attempt" | "ownerPid" | "leaseAt">,
  ) {
    return writing(paths, (client) => reserveLaunch(client, checkout, repository, launch));
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
  /** With `review`, the association also queues the optional assignment-origin review request. */
  associatePullRequest(
    paths: Paths,
    launchId: string,
    pr: Parameters<typeof associatePullRequest>[2],
    review = false,
  ) {
    return writing(paths, (client) => associatePullRequest(client, launchId, pr, review));
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
  /** The cursor of a watched channel, or null before its first watch, and pending effects. */
  readSlack(paths: Paths, channel: string) {
    return reading(paths, (client) => readSlack(client, channel));
  },
  /** Records the start cursor of a channel on its first watch. A recorded cursor stays. */
  startSlackWatch(paths: Paths, channel: string, start: string) {
    return writing(paths, (client) => startSlackWatch(client, channel, start));
  },
  /** Records the eligible PRs of one channel read and moves its cursor in one write. */
  ingestSlack(paths: Paths, input: Parameters<typeof ingestSlack>[1]) {
    return writing(paths, (client) => ingestSlack(client, input));
  },
  acknowledgeSlackEffect(
    paths: Paths,
    id: string,
    decide: Parameters<typeof acknowledgeSlackEffect>[2],
  ) {
    return writing(paths, (client) => acknowledgeSlackEffect(client, id, decide));
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
        detail: `Project records were removed, but file cleanup is still pending. Repeat project remove ${repository} --person-instructed after resolving the path or I/O failure. ${cleaned.error.detail}`,
      });
    return cleaned.map(() => ({ reason: "project_removed" as const, data: { repository } }));
  },
};
