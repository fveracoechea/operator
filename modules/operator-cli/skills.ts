import { OwnedSkills } from "../owned-skills/main.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

function skillArgs(args: string[]) {
  if (args[0] !== "install") return false;
  const upstream = args[1] === "matt";
  const flags = args.slice(upstream ? 2 : 1);
  if (
    new Set(flags).size !== flags.length ||
    flags.some((flag) => !["--opencode", "--claude", "--check", "--json"].includes(flag))
  )
    return null;
  const hosts: Array<keyof ReturnType<typeof OperatorHome.resolve>["skillHosts"]> = [];
  if (flags.includes("--opencode")) hosts.push("opencode");
  if (flags.includes("--claude")) hosts.push("claude-code");
  if (hosts.length === 0) return null;
  if (upstream && flags.includes("--check")) return null;
  return { upstream, hosts, check: flags.includes("--check") };
}

export async function runSkills(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = skillArgs(args);
  if (!parsed) return false;
  const { upstream, hosts, check } = parsed;
  if (upstream) console.error(UpstreamSkills.replacementPolicy());
  const result = await (upstream
    ? UpstreamSkills.install(hosts, paths)
    : OwnedSkills.install({ paths, hosts, check }));
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
      result.error.reason === "skill_copy_conflict"
        ? 4
        : result.error.reason === "upstream_install_unconfirmed"
          ? 5
          : 1,
      json,
    );
  else failure("install", "skills_defect", String(result.cause), 1, json);
  return true;
}
