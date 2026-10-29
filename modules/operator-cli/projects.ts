import { Projects } from "../projects/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

export const projectExitCodes = {
  repository_choice_invalid: 2,
  repository_choice_required: 3,
  github_remote_missing: 3,
  git_unavailable: 3,
  git_checkout_invalid: 3,
  bare_repository: 3,
  linked_checkout: 3,
  legacy_project_state: 3,
  state_missing: 3,
  state_busy: 1,
  state_io_failed: 1,
  state_corrupt: 3,
  state_incompatible: 3,
  state_backup_failed: 1,
  state_migration_blocked: 3,
  controller_mismatch: 4,
  controller_identity_mismatch: 4,
  project_not_registered: 3,
  project_io_failed: 1,
  project_source_open: 3,
  project_cleanup_open: 3,
  project_review_open: 3,
  project_cleanup_pending: 1,
  person_instruction_required: 3,
};

const projectCommands = ["register", "show", "list", "move", "remove"] as const;

export function projectArgs(args: string[]) {
  const [group, name, ...flags] = args;
  const command = projectCommands.find((known) => known === name);
  if (group !== "project" || command === undefined) return null;
  if (command === "remove") {
    const [identity, ...rest] = flags;
    if (!identity || identity.startsWith("--")) return null;
    const parsed = projectFlags(rest, command);
    return parsed && { command, repository: identity, personInstructed: parsed.personInstructed };
  }
  const parsed = projectFlags(flags, command);
  return parsed && { command, ...parsed };
}

function projectFlags(flags: string[], command: string) {
  let repository: string | undefined;
  let personInstructed = false;
  const seen = new Set<string>();
  const rest = flags.values();
  for (const flag of rest) {
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--json") continue;
    if (flag === "--person-instructed" && command === "remove") personInstructed = true;
    else if (flag === "--repository" && ["register", "move"].includes(command)) {
      repository = rest.next().value;
      if (repository === undefined || repository.startsWith("--")) return null;
    } else return null;
  }
  return { repository, personInstructed };
}

export async function runProject(args: string[], paths: OperatorPaths, json: boolean) {
  const project = projectArgs(args);
  if (project === null) return false;
  const input = { paths, cwd: process.cwd(), repository: project.repository };
  const result = await (project.command === "list"
    ? Projects.list(paths)
    : project.command === "remove"
      ? Projects.remove({
          paths,
          repository: project.repository,
          personInstructed: project.personInstructed,
        })
      : project.command === "move"
        ? Projects.move(input)
        : project.command === "register"
          ? Projects.register(input)
          : Projects.current(input));
  const operation = `project_${project.command}`;
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err")
    failure(
      operation,
      result.error.reason,
      result.error.detail,
      projectExitCodes[result.error.reason],
      json,
    );
  else failure(operation, "project_defect", String(result.cause), 1, json);
  return true;
}
