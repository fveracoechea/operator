import { OwnedSkills } from "../owned-skills/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

export async function runSkills(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  if (args[0] !== "install") return false;
  const flags = args.slice(1);
  if (
    new Set(flags).size !== flags.length ||
    flags.some((flag) => !["--opencode", "--claude", "--check", "--json"].includes(flag))
  )
    return false;
  const hosts: Array<keyof typeof paths.skillHosts> = [];
  if (flags.includes("--opencode")) hosts.push("opencode");
  if (flags.includes("--claude")) hosts.push("claude-code");
  if (hosts.length === 0) return false;
  const result = await OwnedSkills.install({ paths, hosts, check: flags.includes("--check") });
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation: "install",
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
      "install",
      result.error.reason,
      result.error.detail,
      result.error.reason === "skill_copy_conflict" ? 4 : 1,
      json,
    );
  else failure("install", "skills_defect", String(result.cause), 1, json);
  return true;
}
