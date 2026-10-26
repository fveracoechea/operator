// Bun has no directory creation API.
import { mkdir } from "node:fs/promises";
import { fromPromise, Ok, Err, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { inspectCheckout, type CheckoutFailure } from "./checkout.ts";
import { selectRepository } from "./identity.ts";

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

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST"].includes(
      String(cause.code),
    )
  )
    return { reason: "project_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

/** Git observations finish before the state owner takes any SQLite write lock. */
export const Projects = {
  register(input: { paths: Paths; cwd: string; repository?: string }) {
    return fromPromise(() => inspectCheckout(input.cwd), qualify)
      .flatMap((observed): Result<ProjectOutcome, ProjectFailure> => {
        if ("reason" in observed) return Err(observed);
        const selected = selectRepository(observed.repositories, input.repository);
        if ("reason" in selected) return Err(selected);
        return DeviceState.registerProject(input.paths, {
          repository: selected.repository,
          checkout: observed.checkout,
          registeredAt: new Date().toISOString(),
        });
      })
      .flatMap((outcome) =>
        fromPromise(
          () =>
            mkdir(OperatorHome.projectDirectory(input.paths, outcome.data.repository), {
              recursive: true,
              mode: 0o700,
            }),
          qualify,
        ).map(() => outcome),
      );
  },
  current(input: { paths: Paths; cwd: string }) {
    return fromPromise(() => inspectCheckout(input.cwd), qualify).flatMap(
      (observed): Result<ProjectOutcome, ProjectFailure> => {
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
              detail: `Use the recorded controlling checkout at ${matches.map((project) => project.checkout).join(", ")}. If it is missing, an explicit project move is required when that operation is available.`,
            });
          return Err({
            reason: "project_not_registered" as const,
            detail: "This checkout is not registered. Run operator project register explicitly.",
          });
        });
      },
    );
  },
};
