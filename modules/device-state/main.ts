import { Err, fromThrowable, type Result } from "unthrown";
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
  leaseRenewMs,
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

type Paths = ReturnType<typeof OperatorHome.resolve>;

function withDatabase<T, E>(
  paths: Paths,
  readonly: boolean,
  action: (client: ReturnType<typeof openDatabase>) => Result<T, E>,
) {
  return fromThrowable((): Result<T, E | StateFailure> => {
    if (!databaseExists(paths.database))
      return Err({
        reason: "state_missing",
        detail: "Register the project explicitly before this operation.",
      });
    using client = openDatabase(paths.database, readonly);
    return action(client);
  }, qualifyStateFailure)().flatMap((result) => result);
}

function hold(renew: () => unknown) {
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
    return fromThrowable(() => {
      if (!databaseExists(paths.database))
        return Err<StateFailure>({
          reason: "state_missing",
          detail: "Register the project explicitly before registering a source.",
        });
      using client = openDatabase(paths.database, false);
      return registerSource(client, checkout, source, assignments);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
  reserveLaunch(
    paths: Paths,
    checkout: string,
    repository: string,
    launch: Omit<LaunchRow, "attempt" | "ownerPid" | "leaseAt">,
  ) {
    return withDatabase(paths, false, (client) =>
      reserveLaunch(client, checkout, repository, launch),
    );
  },
  updateLaunch(paths: Paths, id: string, change: Parameters<typeof updateLaunch>[2]) {
    return withDatabase(paths, false, (client) => updateLaunch(client, id, change));
  },
  /** Apply one report transition that the caller's rule decides from facts read in the same transaction. */
  changeReport<E extends { reason: string; detail: string }>(
    paths: Paths,
    target: ReportTarget,
    decide: Parameters<typeof changeReport<E>>[2],
  ) {
    return withDatabase(paths, false, (client) => changeReport(client, target, decide));
  },
  readReport(paths: Paths, target: ReportTarget) {
    return withDatabase(paths, true, (client) => readReport(client, target));
  },
  launchNames(paths: Paths) {
    return withDatabase(paths, true, (client) => launchNames(client));
  },
  observePane(paths: Paths, input: Parameters<typeof observePane>[1]) {
    return withDatabase(paths, false, (client) => observePane(client, input));
  },
  beginPreparation(paths: Paths, path: string, repository: string) {
    return withDatabase(paths, false, (client) => beginPreparation(client, path, repository));
  },
  finishPreparation(paths: Paths, path: string, outcome: Parameters<typeof finishPreparation>[2]) {
    return withDatabase(paths, false, (client) => finishPreparation(client, path, outcome));
  },
  readPreparation(paths: Paths, path: string) {
    return withDatabase(paths, true, (client) => readPreparation(client, path));
  },
  /** Renew this process's lease on a starting launch until the returned stop runs. */
  holdLaunch(paths: Paths, id: string) {
    return hold(() => withDatabase(paths, false, (client) => renewLaunch(client, id)));
  },
  /** Renew this process's lease on a running preparation until the returned stop runs. */
  holdPreparation(paths: Paths, path: string) {
    return hold(() => withDatabase(paths, false, (client) => renewPreparation(client, path)));
  },
  worktreeOwners(paths: Paths) {
    return withDatabase(paths, true, (client) => worktreeOwners(client));
  },
  /** With `review`, the association also queues the optional assignment-origin review request. */
  associatePullRequest(
    paths: Paths,
    launchId: string,
    pr: Parameters<typeof associatePullRequest>[2],
    review = false,
  ) {
    return withDatabase(paths, false, (client) =>
      associatePullRequest(client, launchId, pr, review),
    );
  },
  /** Apply one review-request transition that the caller's rule decides from the active request. */
  changeReviewRequest<E>(
    paths: Paths,
    target: { repository: string; number: number },
    decide: (current: ReviewSnapshot) => Result<ReviewChange, E>,
  ) {
    return withDatabase(paths, false, (client) => changeReviewRequest(client, target, decide));
  },
  readReviewRequest(paths: Paths, target: { repository: string; number: number }) {
    return withDatabase(paths, true, (client) => readReviewRequest(client, target));
  },
  readReviewRequests(paths: Paths) {
    return withDatabase(paths, true, (client) => readReviewRequests(client));
  },
  /** Renew this process's lease on a reviewer start or a review post until the returned stop runs. */
  holdReviewRequest(paths: Paths, id: string) {
    return hold(() => withDatabase(paths, false, (client) => renewReviewLease(client, id)));
  },
  recordPullRequestWait(
    paths: Paths,
    launchId: string,
    decide: Parameters<typeof recordPullRequestWait>[2],
  ) {
    return withDatabase(paths, false, (client) => recordPullRequestWait(client, launchId, decide));
  },
  /** Renew this process's lease on a running PR wait until the returned stop runs. */
  holdPullRequestWait(paths: Paths, sourceId: string, assignment: string) {
    return hold(() =>
      withDatabase(paths, false, (client) => renewPullRequestWait(client, sourceId, assignment)),
    );
  },
  recordPullRequestMerge(
    paths: Paths,
    launchId: string,
    merge: Parameters<typeof recordPullRequestMerge>[2],
    sourceState: Parameters<typeof recordPullRequestMerge>[3],
  ) {
    return withDatabase(paths, false, (client) =>
      recordPullRequestMerge(client, launchId, merge, sourceState),
    );
  },
  claimCleanup(paths: Paths, repository: string, sourceId: string, assignment: string) {
    return withDatabase(paths, false, (client) =>
      claimCleanup(client, repository, sourceId, assignment),
    );
  },
  startCleanup(paths: Paths, sourceId: string, assignment: string, pid: number) {
    return withDatabase(paths, false, (client) => startCleanup(client, sourceId, assignment, pid));
  },
  advanceCleanup(
    paths: Paths,
    sourceId: string,
    assignment: string,
    change: Parameters<typeof advanceCleanup>[3],
  ) {
    return withDatabase(paths, false, (client) =>
      advanceCleanup(client, sourceId, assignment, change),
    );
  },
  /** Renew this process's lease on a running cleanup until the returned stop runs. */
  holdCleanup(paths: Paths, sourceId: string, assignment: string) {
    return hold(() =>
      withDatabase(paths, false, (client) => renewCleanup(client, sourceId, assignment)),
    );
  },
  /** Renew this process's claim on a PR relay until the returned stop runs. */
  holdPullRequestRelay(paths: Paths, sourceId: string, assignment: string) {
    return hold(() =>
      withDatabase(paths, false, (client) => renewPullRequestRelay(client, sourceId, assignment)),
    );
  },
  readSources(paths: Paths, repository: string, sourceId?: string) {
    return fromThrowable(() => {
      if (!databaseExists(paths.database))
        return Err<StateFailure>({
          reason: "state_missing",
          detail: "Register the project explicitly before reading sources.",
        });
      using client = openDatabase(paths.database, true);
      return readSources(client, repository, sourceId);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
  registerProject(paths: Paths, project: RegisteredProject) {
    return fromThrowable(() => {
      if (!databaseExists(paths.database)) return createDatabase(paths, project);
      using client = openDatabase(paths.database, false);
      return registerProject(client, project);
    }, qualifyStateFailure)()
      .flatMap((result) => result)
      .flatMap((outcome) =>
        fromThrowable(() => {
          using client = openDatabase(paths.database, false);
          return ensureProjectDirectory(client, paths, outcome.data).map(() => outcome);
        }, qualifyStateFailure)().flatMap((result) => result),
      );
  },
  lookupProject(paths: Paths, checkout: string, repositories: string[]) {
    return fromThrowable(() => {
      if (!databaseExists(paths.database))
        return Err<StateFailure>({
          reason: "state_missing",
          detail:
            "The device database is missing. Run operator project register explicitly in the controlling checkout.",
        });
      using client = openDatabase(paths.database, true);
      return lookupProject(client, checkout, repositories);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
  listProjects(paths: Paths) {
    return fromThrowable(() => {
      using client = openDatabase(paths.database, true);
      return listProjects(client);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
  moveProject(paths: Paths, repository: string, checkout: string) {
    return fromThrowable(() => {
      using client = openDatabase(paths.database, false);
      return moveProject(client, repository, checkout);
    }, qualifyStateFailure)().flatMap((result) => result);
  },
  removeProject(paths: Paths, repository: string) {
    const removed = fromThrowable(() => {
      using client = openDatabase(paths.database, false);
      return removeProject(client, repository);
    }, qualifyStateFailure)().flatMap((result) => result);
    if (removed.tag !== "Ok") return removed;
    const cleaned = fromThrowable(() => {
      using client = openDatabase(paths.database, false);
      return finishProjectRemoval(client, paths, repository);
    }, qualifyStateFailure)().flatMap((result) => result);
    if (cleaned.tag === "Err")
      return Err({
        reason: "project_cleanup_pending" as const,
        detail: `Project records were removed, but file cleanup is still pending. Repeat project remove ${repository} --person-instructed after resolving the path or I/O failure. ${cleaned.error.detail}`,
      });
    return cleaned.map(() => ({ reason: "project_removed" as const, data: { repository } }));
  },
};
