import { OwnedSkills } from "../owned-skills/main.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

const skillExitCodes = {
  skill_copy_conflict: 4,
  skills_missing: 3,
  upstream_install_unconfirmed: 5,
};

function skillArgs(args: string[]) {
  if (args[0] !== "install") return null;
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
  if (parsed === null) return false;
  const { upstream, hosts, check } = parsed;
  if (upstream) console.error(UpstreamSkills.replacementPolicy());
  const result = await (upstream
    ? UpstreamSkills.install(hosts, paths)
    : OwnedSkills.install({ paths, hosts, check }));
  respond({
    operation: "install",
    result,
    exitCodes: skillExitCodes,
    fallback: 1,
    defect: "skills_defect",
    json,
  });
  return true;
}
