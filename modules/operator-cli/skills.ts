import { OkAsync } from "unthrown";
import { ClaudeHook } from "../claude-hook/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
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

/**
 * Installs owned skills, then delegates the upstream skills. A check starts no upstream work.
 * The Claude Code commit hook comes last, so a settings refusal leaves the skills installed.
 */
export async function runSkills(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = skillArgs(args);
  if (parsed === null) return false;
  const { hosts, check } = parsed;
  const result = await OwnedSkills.install({ paths, hosts, check })
    .flatMap((owned) => {
      if (check) return OkAsync(owned);
      console.error(UpstreamSkills.replacementPolicy());
      return UpstreamSkills.install(hosts, paths).map((upstream) => ({
        reason: owned.reason,
        data: { ...owned.data, upstream: upstream.data },
      }));
    })
    .flatMap((installed) =>
      // A Nix release only checks the hook, as it only checks the owned skills.
      hosts.includes("claude-code")
        ? ClaudeHook.install({ paths, check: installed.data.checkOnly }).map((claudeHook) => ({
            ...installed,
            data: { ...installed.data, claudeHook },
          }))
        : OkAsync(installed),
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
