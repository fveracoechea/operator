import { OkAsync } from "unthrown";
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
  const flags = args.slice(1);
  if (
    new Set(flags).size !== flags.length ||
    flags.some((flag) => !["--opencode", "--claude", "--check", "--json"].includes(flag))
  )
    return null;
  const hosts: Array<keyof ReturnType<typeof OperatorHome.resolve>["skillHosts"]> = [];
  if (flags.includes("--opencode")) hosts.push("opencode");
  if (flags.includes("--claude")) hosts.push("claude-code");
  if (hosts.length === 0) return null;
  return { hosts, check: flags.includes("--check") };
}

/** Installs owned skills, then delegates the upstream skills. A check starts no upstream work. */
export async function runSkills(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = skillArgs(args);
  if (parsed === null) return false;
  const { hosts, check } = parsed;
  const result = await OwnedSkills.install({ paths, hosts, check }).flatMap((owned) => {
    if (check) return OkAsync(owned);
    console.error(UpstreamSkills.replacementPolicy());
    return UpstreamSkills.install(hosts, paths).map((upstream) => ({
      reason: owned.reason,
      data: { ...owned.data, upstream: upstream.data },
    }));
  });
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
