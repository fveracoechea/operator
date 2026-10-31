import { ClaudeHook } from "../claude-hook/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { OkAsync } from "unthrown";
import { respond } from "./output.ts";

const skillExitCodes = {
  skill_copy_conflict: 4,
  skills_missing: 3,
  claude_hook_missing: 3,
  claude_settings_external: 4,
  claude_settings_invalid: 4,
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
  const result = upstream
    ? await UpstreamSkills.install(hosts, paths)
    : await OwnedSkills.install({ paths, hosts, check }).flatMap((skills) =>
        // The Claude Code commit hook installs with the skills, and a Nix release only checks it.
        hosts.includes("claude-code")
          ? ClaudeHook.install({ paths, check: skills.data.checkOnly }).map((claudeHook) => ({
              ...skills,
              data: { ...skills.data, claudeHook },
            }))
          : OkAsync(skills),
      );
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
