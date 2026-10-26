// Bun has no temporary-directory, recursive removal, or file metadata API.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { fromPromise, Ok, Err } from "unthrown";
import { z } from "zod";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { commitIdentity, installed, roster } from "./catalog.ts";

type Host = keyof ReturnType<typeof OperatorHome.resolve>["skillHosts"];
const installerVersion = "1.7.4";
const replacementPolicy =
  "The upstream installer owns replacement and its lock. It can replace local edits without an Operator preview. Inspect a failed or interrupted install before trying again.";
const required = ["code-review"];

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "upstream_catalog_invalid" as const, detail: String(cause) };
  if (
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "ELOOP"].includes(
      String(cause.code),
    )
  )
    return { reason: "upstream_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

async function install(hosts: Host[]) {
  const directory = await mkdtemp(OperatorHome.upstreamTemporaryPrefix());
  try {
    const clone = await ToolInvocation.run({
      tool: "git",
      args: [
        "clone",
        "--depth",
        "1",
        "--",
        "https://github.com/mattpocock/skills.git",
        `${directory}/repository`,
      ],
      cwd: directory,
      timeoutMs: 60000,
    });
    if (clone.status !== "completed" || clone.exitCode !== 0)
      return {
        reason: "upstream_resolution_failed" as const,
        detail: "Cannot read the current Matt skills revision. No installer was invoked.",
      };
    const revision = await ToolInvocation.run({
      tool: "git",
      args: ["rev-parse", "HEAD"],
      cwd: `${directory}/repository`,
      timeoutMs: 10000,
    });
    if (revision.status !== "completed" || revision.exitCode !== 0)
      return {
        reason: "upstream_resolution_failed" as const,
        detail: "Cannot resolve a full Matt skills commit. No installer was invoked.",
      };
    const commit = commitIdentity(revision.stdout);
    const documents = [];
    for await (const file of new Bun.Glob("**/SKILL.md").scan({ cwd: `${directory}/repository` }))
      documents.push(await Bun.file(`${directory}/repository/${file}`).text());
    const owned = await OwnedSkills.names();
    const skills = roster(documents, owned);
    if (owned.length === 0 || skills.length === 0)
      return {
        reason: "upstream_catalog_invalid" as const,
        detail:
          "A complete owned catalog and a nonempty upstream roster are required. No installer was invoked.",
      };
    const args = [
      "x",
      "--bun",
      `skills@${installerVersion}`,
      "add",
      `mattpocock/skills#${commit}`,
      "--global",
      "--agent",
      ...hosts,
      "--skill",
      ...skills,
      "--yes",
      "--json",
    ];
    const result = await ToolInvocation.run({
      tool: "bun",
      args,
      cwd: directory,
      timeoutMs: 120000,
    });
    if (result.status === "unavailable")
      return { reason: "upstream_installer_unavailable" as const, detail: result.detail };
    if (result.status === "no-answer")
      return {
        reason: "upstream_install_unconfirmed" as const,
        detail: `${result.detail} ${replacementPolicy}`,
      };
    if (result.exitCode !== 0)
      return {
        reason: "upstream_install_failed" as const,
        detail: `${result.stderr} ${replacementPolicy}`,
      };
    if (!installed(result.stdout, skills))
      return {
        reason: "upstream_install_unconfirmed" as const,
        detail: `The installer did not confirm every selected skill. ${replacementPolicy}`,
      };
    return {
      reason: "upstream_installed" as const,
      data: { installerVersion, commit, hosts, skills, replacementPolicy },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Delegates installation and lock ownership. Presence checks do not compare upstream revisions. */
export const UpstreamSkills = {
  replacementPolicy() {
    return replacementPolicy;
  },
  install(hosts: Host[], paths: ReturnType<typeof OperatorHome.resolve>) {
    return fromPromise(async () => {
      OperatorHome.guardSkillTests(
        Environment.read(),
        hosts.map((host) => paths.upstreamSkills[host]),
      );
      return install(hosts);
    }, qualify).flatMap((outcome) => (outcome.detail !== undefined ? Err(outcome) : Ok(outcome)));
  },
  check(paths: ReturnType<typeof OperatorHome.resolve>, host: Host) {
    return fromPromise(async () => {
      OperatorHome.guardSkillTests(Environment.read(), [paths.upstreamSkills[host]]);
      const missing = [];
      for (const name of required) {
        const file = `${paths.upstreamSkills[host]}/${name}/SKILL.md`;
        try {
          if (!(await stat(file)).isFile() || (await Bun.file(file).text()).trim().length === 0)
            missing.push(file);
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
          )
            missing.push(file);
          // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
          else throw cause;
        }
      }
      return missing;
    }, qualify);
  },
};
