import { Err, Ok, type Result } from "unthrown";
import type { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";

export type Paths = ReturnType<typeof OperatorHome.resolve>;
export type Failure = { reason: string; detail: string };
export type Target = Parameters<typeof DeviceState.readQuestion>[1];
export type Selector = {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  key: string;
};

/** Carry an earlier step's refusal or defect into the command result. Its callback never runs. */
export function stop(result: Result<unknown, Failure>): Result<never, Failure> {
  // Stryker disable next-line ArrowFunction: equivalent: the callback runs only for a success, and no caller stops a success
  return result.flatMap(() => stop(result));
}

/** The pane that runs a command. A worker's pane identifies its assignment. */
export function caller() {
  const environment = Environment.read();
  return {
    socket: environment.HERDR_SOCKET_PATH ?? null,
    paneId: environment.HERDR_PANE_ID ?? null,
  };
}

export function workerPane(): Result<Target, Failure> {
  const { socket, paneId } = caller();
  return socket === null || paneId === null
    ? Err({
        reason: "worker_pane_required",
        detail:
          "Run this command in the Herdr pane that Operator dispatched for the assignment. Nothing changed.",
      })
    : Ok({ by: "pane", socket, paneId });
}

/** The SuperAgent names the assignment from the project's controlling checkout. */
export function superAgentTarget(input: Selector) {
  return Projects.current(input).map(({ data }) => ({
    by: "key" as const,
    repository: data.repository,
    checkout: data.checkout,
    sourceId: input.sourceId,
    assignment: input.assignment,
  }));
}

export function now() {
  return new Date().toISOString();
}
