import { ClaudeHook } from "../claude-hook/main.ts";
import { DeviceSettings } from "../device-settings/main.ts";
import { GlobalLauncher } from "../global-launcher/main.ts";
import { OpenCodePlugin } from "../opencode-plugin/main.ts";
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
  | Extract<Awaited<ReturnType<typeof UpstreamSkills.checkGuides>>, { tag: "Err" }>["error"]
  | Extract<
      Awaited<ReturnType<typeof UpstreamSkills.checkGuides>>,
      { tag: "Ok" }
    >["value"]["blockers"][number]
  | Extract<Awaited<ReturnType<typeof ClaudeHook.install>>, { tag: "Err" }>["error"]
  | Extract<Awaited<ReturnType<typeof OpenCodePlugin.install>>, { tag: "Err" }>["error"]
  | Extract<Awaited<ReturnType<typeof GlobalLauncher.check>>, { tag: "Ok" }>["value"][number]
  | Extract<Awaited<ReturnType<typeof GlobalLauncher.check>>, { tag: "Err" }>["error"];

type Host = "opencode" | "claude-code";
type Checked = {
  blockers: Blocker[];
  warnings: Extract<
    Awaited<ReturnType<typeof UpstreamSkills.checkGuides>>,
    { tag: "Ok" }
  >["value"]["warnings"];
};

/** The executable, the owned and upstream skills, and the Operator hook of one host. */
async function checkHost(paths: ReturnType<typeof OperatorHome.resolve>, host: Host) {
  const blockers: Blocker[] = [];
  const warnings: Extract<
    Awaited<ReturnType<typeof UpstreamSkills.checkGuides>>,
    { tag: "Ok" }
  >["value"]["warnings"] = [];
  const tool = host === "opencode" ? "opencode" : "claude";
  const flag = host === "opencode" ? "--opencode" : "--claude";
  if (Bun.which(tool, { PATH: Environment.read().PATH }) === null)
    blockers.push({ reason: "executable_missing", tool, detail: `Install ${tool} on PATH.` });
  const owned = await OwnedSkills.install({ paths, hosts: [host], check: true });
  // Stryker disable next-line ArrowFunction: equivalent: map on a Defect never calls its function
  if (owned.tag === "Defect") return owned.map((): Checked => ({ blockers, warnings }));
  if (owned.tag === "Err")
    blockers.push({
      ...owned.error,
      detail: `${owned.error.detail} Run operator install ${flag}, or update consumer-owned Nix links.`,
    });
  const upstream = await UpstreamSkills.checkGuides(paths, host);
  // Stryker disable next-line ArrowFunction: equivalent: map on a Defect never calls its function
  if (upstream.tag === "Defect") return upstream.map((): Checked => ({ blockers, warnings }));
  if (upstream.tag === "Err") blockers.push(upstream.error);
  else {
    blockers.push(...upstream.value.blockers);
    warnings.push(...upstream.value.warnings);
  }
  const hook = await (host === "claude-code" ? ClaudeHook : OpenCodePlugin).install({
    paths,
    check: true,
  });
  // Stryker disable next-line ArrowFunction: equivalent: map on a Defect never calls its function
  if (hook.tag === "Defect") return hook.map((): Checked => ({ blockers, warnings }));
  if (hook.tag === "Err") blockers.push(hook.error);
  return Ok({ blockers, warnings });
}

/** A worker loads its own host's skills, so every host that settings select needs its checks. */
function checkHosts(paths: ReturnType<typeof OperatorHome.resolve>, only: Host | undefined) {
  return fromPromise(
    async () => {
      const settings = await DeviceSettings.show(paths);
      // Stryker disable next-line ArrowFunction: equivalent: map on a Defect never calls its function
      if (settings.tag === "Defect")
        return settings.map((): Checked => ({ blockers: [], warnings: [] }));
      if (settings.tag === "Err") return Ok({ blockers: [settings.error], warnings: [] });
      const config = settings.value.data.config;
      if (config.superAgent.host === undefined)
        return Ok({
          blockers: [
            {
              reason: "host_unconfigured" as const,
              detail: "Set superAgent.host in device settings.",
            },
          ],
          warnings: [],
        });
      const selected = [
        config.superAgent.host,
        config.workerAgent.host,
        ...Object.values(config.profiles ?? {}).map((profile) => profile.host),
      ];
      const hosts =
        only === undefined ? [...new Set(selected.filter((host) => host !== undefined))] : [only];
      const blockers: Blocker[] = [];
      const warnings: Extract<
        Awaited<ReturnType<typeof UpstreamSkills.checkGuides>>,
        { tag: "Ok" }
      >["value"]["warnings"] = [];
      for (const host of hosts) {
        const checked = await checkHost(paths, host);
        if (checked.tag !== "Ok") return checked;
        blockers.push(...checked.value.blockers);
        warnings.push(...checked.value.warnings);
      }
      return Ok({ blockers, warnings });
    },
    (cause, defect) => defect(cause),
  ).flatMap<Checked, Blocker>((result) => result);
}

/**
 * Reports current static facts. It never initializes a host or saves a readiness result.
 * With a host, it checks only that host, as a launch on it needs.
 */
export const Readiness = {
  check(paths: ReturnType<typeof OperatorHome.resolve>, options: { host?: Host } = {}) {
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
        // Stryker disable next-line ArrowFunction,ObjectLiteral: equivalent: map on a Defect never calls its function
        if (command.tag === "Defect")
          return command.map((): Checked => ({ blockers, warnings: [] }));
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
        const host = await checkHosts(paths, options.host);
        return host.map((values) => ({
          blockers: [...blockers, ...values.blockers],
          warnings: values.warnings,
        }));
      },
      (cause, defect) => defect(cause),
    ).flatMap((result) => result);
  },
};
