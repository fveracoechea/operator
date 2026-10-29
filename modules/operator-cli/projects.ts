import { Projects } from "../projects/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

// Other project refusals need a person or a setup step, so they exit 3.
const projectExitCodes = {
  repository_choice_invalid: 2,
  project_cleanup_pending: 1,
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
  respond({ operation, result, exitCodes: projectExitCodes, defect: "project_defect", json });
  return true;
}
