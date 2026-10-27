import { DeviceSettings } from "../device-settings/main.ts";
import { GlobalLauncher } from "../global-launcher/main.ts";
import { Environment } from "../environment/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import { fromPromise, Ok } from "unthrown";

type Blocker =
  | {
      reason: "executable_missing";
      tool: "gh" | "herdr" | "opencode" | "claude";
      detail: string;
    }
  | {
      reason: "host_unconfigured" | "github_auth_failed" | "upstream_skills_missing";
      detail: string;
    }
  | Extract<Awaited<ReturnType<typeof DeviceSettings.show>>, { tag: "Err" }>["error"]
  | Extract<Awaited<ReturnType<typeof OwnedSkills.install>>, { tag: "Err" }>["error"]
  | Extract<Awaited<ReturnType<typeof UpstreamSkills.check>>, { tag: "Err" }>["error"]
  | Extract<Awaited<ReturnType<typeof GlobalLauncher.check>>, { tag: "Ok" }>["value"][number]
  | Extract<Awaited<ReturnType<typeof GlobalLauncher.check>>, { tag: "Err" }>["error"];

function checkHost(paths: ReturnType<typeof OperatorHome.resolve>) {
  return fromPromise(
    async () => {
      const blockers: Blocker[] = [];
      const settings = await DeviceSettings.show(paths);
      if (settings.tag === "Defect") return settings.map(() => blockers);
      if (settings.tag === "Err") return Ok([settings.error]);
      const host = settings.value.data.config.superAgent.host;
      if (host === undefined)
        return Ok([
          {
            reason: "host_unconfigured" as const,
            detail: "Set superAgent.host in device settings.",
          },
        ]);
      const tool = host === "opencode" ? "opencode" : "claude";
      if (Bun.which(tool, { PATH: Environment.read().PATH }) === null)
        blockers.push({ reason: "executable_missing", tool, detail: `Install ${tool} on PATH.` });
      const owned = await OwnedSkills.install({ paths, hosts: [host], check: true });
      if (owned.tag === "Defect") return owned.map(() => blockers);
      if (owned.tag === "Err")
        blockers.push({
          ...owned.error,
          detail: `${owned.error.detail} Run operator install ${host === "opencode" ? "--opencode" : "--claude"}, or update consumer-owned Nix links.`,
        });
      const upstream = await UpstreamSkills.check(paths, host);
      if (upstream.tag === "Defect") return upstream.map(() => blockers);
      if (upstream.tag === "Err") blockers.push(upstream.error);
      else if (upstream.value.length > 0)
        blockers.push({
          reason: "upstream_skills_missing",
          detail: `Run operator install matt ${host === "opencode" ? "--opencode" : "--claude"}. Missing required skill files: ${upstream.value.join(", ")}`,
        });
      return Ok(blockers);
    },
    (cause, defect) => defect(cause),
  ).flatMap<Blocker[], Blocker>((result) => result);
}

/** Reports current static facts. It never initializes a host or saves a readiness result. */
export const Readiness = {
  check(paths: ReturnType<typeof OperatorHome.resolve>) {
    return fromPromise(
      async () => {
        const blockers: Blocker[] = [];
        for (const tool of ["gh", "herdr"] as const) {
          if (Bun.which(tool, { PATH: Environment.read().PATH }) === null)
            blockers.push({
              reason: "executable_missing",
              tool,
              detail: `Install ${tool} on PATH.`,
            });
        }
        // Herdr hooks and agents reach the running release only through the global command.
        const command = await GlobalLauncher.check();
        if (command.tag === "Defect") return command.map(() => ({ blockers }));
        if (command.tag === "Err") blockers.push(command.error);
        else blockers.push(...command.value);
        if (!blockers.some((blocker) => "tool" in blocker && blocker.tool === "gh")) {
          const auth = await ToolInvocation.run({
            tool: "gh",
            args: ["auth", "status", "--hostname", "github.com"],
            timeoutMs: 10000,
          });
          if (auth.status !== "completed" || auth.exitCode !== 0)
            blockers.push({
              reason: "github_auth_failed",
              detail: "Run gh auth login for github.com.",
            });
        }
        const host = await checkHost(paths);
        return host.map((values) => ({ blockers: [...blockers, ...values] }));
      },
      (cause, defect) => defect(cause),
    ).flatMap((result) => result);
  },
};
