import { fromPromise, fromThrowable, Ok, Err } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { planSchema } from "./plan.ts";
import { decideAssignment } from "./assignment-machine.ts";
import { decideSource } from "./source-machine.ts";
import { decodeSource } from "./snapshot.ts";

type Input = { paths: ReturnType<typeof OperatorHome.resolve>; cwd: string };

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "invalid_source_plan" as const, detail: cause.message };
  if (
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "ENOTDIR"].includes(String(cause.code))
  )
    return { reason: "source_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

function read(input: Input & { sourceId?: string }) {
  return Projects.current(input)
    .flatMap(({ data }) => DeviceState.readSources(input.paths, data.repository, input.sourceId))
    .flatMap((rows) =>
      fromThrowable(
        () => rows.map(decodeSource),
        (cause, defect) =>
          cause instanceof z.ZodError || cause instanceof SyntaxError
            ? {
                reason: "state_corrupt" as const,
                detail: "Stored source records are invalid. They were not repaired.",
              }
            : defect(cause),
      )(),
    );
}

/** Plans are supplied by the SuperAgent. No operation reads or updates a tracker. */
export const WorkSources = {
  register(input: Input & { file: string }) {
    return fromPromise(async () => planSchema.parse(await Bun.file(input.file).json()), qualify)
      .flatMap((plan) =>
        DeviceSettings.show(input.paths).flatMap(({ data: settings }) => {
          const missing = plan.assignments.find(
            (assignment) =>
              assignment.profile !== undefined &&
              !Object.hasOwn(settings.config.profiles ?? {}, assignment.profile),
          );
          if (missing)
            return Err({
              reason: "source_profile_missing" as const,
              detail: `The profile ${missing.profile} for ${missing.key} does not exist. No source was written.`,
            });
          return Ok(plan);
        }),
      )
      .flatMap((plan) =>
        Projects.current(input).flatMap(({ data: project }) => {
          const id = crypto.randomUUID();
          const registeredAt = new Date().toISOString();
          const assignments = plan.assignments.map((assignment) => ({
            sourceId: id,
            key: assignment.key,
            completion: assignment.completion,
            state: "ready" as const,
          }));
          const state = decideSource({
            state: "open",
            assignments: plan.assignments.map((assignment) => ({
              key: assignment.key,
              completion: assignment.completion,
              state: "ready",
            })),
          });
          return DeviceState.registerSource(
            input.paths,
            project.checkout,
            {
              id,
              repository: project.repository,
              trackerKey: plan.trackerKey,
              state,
              registeredAt,
              endedAt: state === "finished" ? registeredAt : null,
              plan: JSON.stringify(plan),
            },
            assignments,
          ).map((source) => ({
            ...source,
            plan,
            assignments: assignments.map(({ key, completion, state }) => ({
              key,
              completion,
              state,
            })),
          }));
        }),
      );
  },
  show(input: Input & { sourceId: string }) {
    return read(input).map((sources) => sources[0]);
  },
  next(input: Input & { sourceId?: string }) {
    return read(input).flatMap((sources) =>
      fromThrowable(
        () => ({
          sources: sources.map((source) => {
            const state = source.state;
            if (state !== "open")
              return {
                id: source.id,
                state,
                actions: [{ action: "source_ended", reason: state }],
                waits: [],
              };
            const decisions = source.plan.assignments.map((assignment) => {
              const current = source.assignments.find((row) => row.key === assignment.key);
              const dependencies = assignment.dependencies.map((key) =>
                source.assignments.find((row) => row.key === key),
              );
              if (
                current === undefined ||
                dependencies.some((dependency) => dependency === undefined)
              ) {
                // oxlint-disable-next-line unthrown/no-throw -- Inconsistent persisted rows are corruption, not permission to schedule work.
                throw new z.ZodError([]);
              }
              const decision = decideAssignment({
                assignment: current,
                dependencies: dependencies.filter((dependency) => dependency !== undefined),
              });
              return { assignment: assignment.key, ...decision };
            });
            return {
              id: source.id,
              state,
              actions: decisions.filter((decision) => decision.action === "ready_assignment"),
              waits: decisions.filter((decision) => decision.action === "wait"),
            };
          }),
        }),
        (cause, defect) =>
          cause instanceof z.ZodError
            ? {
                reason: "state_corrupt" as const,
                detail: "The source assignments do not match their plan.",
              }
            : defect(cause),
      )(),
    );
  },
};
