// Bun has no directory metadata API.
import { isCodedError } from "../../lib/coded-error.ts";
import { stat } from "node:fs/promises";
import { fromPromise, Ok, Err, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { githubRemote, inspectCheckout, type CheckoutFailure } from "./checkout.ts";
import { repositoryIdentity, selectRepository } from "./identity.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type StateResult = ReturnType<typeof DeviceState.registerProject>;
type StateFailure = Extract<StateResult, { tag: "Err" }>["error"];
type RegisteredProject = Extract<StateResult, { tag: "Ok" }>["value"]["data"];
type ProjectFailure =
  | StateFailure
  | CheckoutFailure
  | {
      reason:
        | "repository_choice_invalid"
        | "repository_choice_required"
        | "github_remote_missing"
        | "project_io_failed"
        | "project_not_registered";
      detail: string;
    };
type ProjectOutcome = {
  reason: "project_registered" | "project_unchanged" | "project_resolved";
  data: RegisteredProject;
};
type ControllerStatus =
  | { status: "missing" | "available" | "mismatched" }
  | { status: "blocked"; reason: CheckoutFailure["reason"] | "project_io_failed"; detail: string };

function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (
    isCodedError(cause) &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST"].includes(
      cause.code,
    )
  )
    return { reason: "project_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

/** Git observations finish before the state owner takes any SQLite write lock. */
export const Projects = {
  remove(input: { paths: Paths; repository: string; personInstructed: boolean }) {
    const repository = repositoryIdentity(input.repository);
    if (repository === null)
      return Err({
        reason: "repository_choice_invalid" as const,
        detail: "Removal requires an explicit owner/repository identity.",
      });
    if (!input.personInstructed)
      return Err({
        reason: "person_instruction_required" as const,
        detail:
          "Remove a project only on the person's explicit instruction. --person-instructed attests that instruction, it does not grant authority.",
      });
    return DeviceState.removeProject(input.paths, repository);
  },
  move(input: { paths: Paths; cwd: string; repository?: string }) {
    return fromPromise(
      () => inspectCheckout(input.cwd),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap(
      (observed): Result<{ reason: "project_moved"; data: RegisteredProject }, ProjectFailure> => {
        if ("reason" in observed) return Err(observed);
        const selected = selectRepository(observed.repositories, input.repository);
        if ("reason" in selected) return Err(selected);
        return DeviceState.moveProject(input.paths, selected.repository, observed.checkout);
      },
    );
  },
  list(paths: Paths) {
    return fromPromise(
      async () => DeviceState.listProjects(paths),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    )
      .flatMap((result) => result)
      .flatMap(({ projects, pendingRemovals }) =>
        fromPromise(
          async () => {
            const listed = [];
            for (const project of projects) {
              let controller: ControllerStatus;
              try {
                await stat(project.checkout);
                const observed = await inspectCheckout(project.checkout);
                controller =
                  "reason" in observed
                    ? { status: "blocked", reason: observed.reason, detail: observed.detail }
                    : {
                        status:
                          observed.checkout === project.checkout &&
                          observed.repositories.includes(project.repository)
                            ? "available"
                            : "mismatched",
                      };
              } catch (cause) {
                if (isCodedError(cause) && cause.code === "ENOENT")
                  controller = { status: "missing" };
                else {
                  const error = cause instanceof Error ? qualify(cause, () => null) : null;
                  // oxlint-disable-next-line unthrown/no-throw -- Expected controller failures are statuses, but defects must still stop the list.
                  if (error === null) throw cause;
                  controller = { status: "blocked", ...error };
                }
              }
              listed.push({ ...project, controller });
            }
            return {
              reason: "projects_listed" as const,
              data: { projects: listed, pendingRemovals },
            };
          },
          (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
        ),
      );
  },
  register(input: { paths: Paths; cwd: string; repository?: string }) {
    return fromPromise(
      () => inspectCheckout(input.cwd),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap((observed): Result<ProjectOutcome, ProjectFailure> => {
      if ("reason" in observed) return Err(observed);
      const selected = selectRepository(observed.repositories, input.repository);
      if ("reason" in selected) return Err(selected);
      return DeviceState.registerProject(input.paths, {
        repository: selected.repository,
        checkout: observed.checkout,
        registeredAt: new Date().toISOString(),
      });
    });
  },
  /** The name of the checkout's remote for this GitHub repository, or null when none matches. */
  githubRemote(input: { checkout: string; repository: string }) {
    return fromPromise(
      () => githubRemote(input.checkout, input.repository),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
  current(input: { paths: Paths; cwd: string }) {
    return fromPromise(
      () => inspectCheckout(input.cwd),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap((observed): Result<ProjectOutcome, ProjectFailure> => {
      if ("reason" in observed) return Err(observed);
      const result = DeviceState.lookupProject(
        input.paths,
        observed.checkout,
        observed.repositories,
      );
      return result.flatMap(({ controller, matches }): Result<ProjectOutcome, ProjectFailure> => {
        if (controller) {
          if (!observed.repositories.includes(controller.repository))
            return Err({
              reason: "controller_identity_mismatch" as const,
              detail: `The controlling checkout no longer has the recorded ${controller.repository} remote. Restore it before use.`,
            });
          return Ok({ reason: "project_resolved" as const, data: controller });
        }
        if (matches.length > 0)
          return Err({
            reason: "controller_mismatch" as const,
            detail: `Use the recorded controlling checkout at ${matches.map((project) => project.checkout).join(", ")}. To change it, run operator project move from a matching main clone when no source is open.`,
          });
        return Err({
          reason: "project_not_registered" as const,
          detail: "This checkout is not registered. Run operator project register explicitly.",
        });
      });
    });
  },
};
