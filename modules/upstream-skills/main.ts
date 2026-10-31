import { isCodedError } from "../../lib/coded-error.ts";
// Bun has no temporary-directory, recursive removal, file metadata, or path API.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "upstream_catalog_invalid" as const, detail: String(cause) };
  if (
    isCodedError(cause) &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "ELOOP"].includes(cause.code)
  )
    return { reason: "upstream_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

// Each source names one repository. A source with a folder selects only the skill in that folder,
// and a source without one selects every skill in the repository that the release does not own.
const sources = [
  { repository: "mattpocock/skills" },
  { repository: "cursor/plugins", folder: "pstack/skills/unslop" },
  { repository: "humanlayer/skills", folder: "plugins/show-me/skills/show-me" },
];

async function resolve(directory: string, source: (typeof sources)[number], owned: string[]) {
  const { repository, folder } = source;
  const checkout = `${directory}/${repository}`;
  const clone = await ToolInvocation.run({
    tool: "git",
    args: ["clone", "--depth", "1", "--", `https://github.com/${repository}.git`, checkout],
    cwd: directory,
    timeoutMs: 60000,
  });
  if (clone.status !== "completed" || clone.exitCode !== 0)
    return {
      reason: "upstream_resolution_failed" as const,
      detail: `Cannot read the current revision of ${repository}. No installer was invoked.`,
    };
  const revision = await ToolInvocation.run({
    tool: "git",
    args: ["rev-parse", "HEAD"],
    cwd: checkout,
    timeoutMs: 10000,
  });
  if (revision.status !== "completed" || revision.exitCode !== 0)
    return {
      reason: "upstream_resolution_failed" as const,
      detail: `Cannot resolve a full commit of ${repository}. No installer was invoked.`,
    };
  const commit = commitIdentity(revision.stdout);
  const documents = [];
  if (folder !== undefined) {
    const file = Bun.file(`${checkout}/${folder}/SKILL.md`);
    if (!(await file.exists()))
      return {
        reason: "upstream_catalog_invalid" as const,
        detail: `${repository} has no skill at ${folder}. No installer was invoked.`,
      };
    documents.push(await file.text());
  } else
    for await (const file of new Bun.Glob("**/SKILL.md").scan({ cwd: checkout }))
      documents.push(await Bun.file(`${checkout}/${file}`).text());
  return {
    repository,
    commit,
    skills: roster(documents, owned),
    // The tree address keeps another copy of the same name elsewhere in the repository out.
    address:
      folder === undefined
        ? `${repository}#${commit}`
        : `https://github.com/${repository}/tree/${commit}/${folder}`,
  };
}

async function install(hosts: Host[]) {
  const directory = await mkdtemp(path.join(tmpdir(), "operator-upstream-"));
  try {
    const owned = await OwnedSkills.names();
    const resolved = [];
    for (const source of sources) {
      const outcome = await resolve(directory, source, owned);
      if (outcome.detail !== undefined) return outcome;
      resolved.push(outcome);
    }
    if (owned.length === 0 || resolved.some((source) => source.skills.length === 0))
      return {
        reason: "upstream_catalog_invalid" as const,
        detail:
          "A complete owned catalog and a nonempty roster for each upstream source are required. No installer was invoked.",
      };
    const names = resolved.flatMap((source) => source.skills);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated !== undefined)
      return {
        reason: "upstream_catalog_invalid" as const,
        detail: `More than one upstream source selects ${repeated}. No installer was invoked.`,
      };
    for (const { repository, address, skills } of resolved) {
      const result = await ToolInvocation.run({
        tool: "bun",
        args: [
          "x",
          "--bun",
          `skills@${installerVersion}`,
          "add",
          address,
          "--global",
          "--agent",
          ...hosts,
          "--skill",
          ...skills,
          "--yes",
          "--json",
        ],
        cwd: directory,
        timeoutMs: 120000,
      });
      if (result.status === "unavailable")
        return { reason: "upstream_installer_unavailable" as const, detail: result.detail };
      if (result.status === "no-answer")
        return {
          reason: "upstream_install_unconfirmed" as const,
          detail: `${repository}: ${result.detail} ${replacementPolicy}`,
        };
      if (result.exitCode !== 0)
        return {
          reason: "upstream_install_failed" as const,
          detail: `${repository}: ${result.stderr} ${replacementPolicy}`,
        };
      if (!installed(result.stdout, skills))
        return {
          reason: "upstream_install_unconfirmed" as const,
          detail: `${repository}: The installer did not confirm every selected skill. ${replacementPolicy}`,
        };
    }
    return {
      reason: "upstream_installed" as const,
      data: {
        installerVersion,
        hosts,
        sources: resolved.map(({ repository, commit, skills }) => ({ repository, commit, skills })),
        replacementPolicy,
      },
    };
  } finally {
    await rm(directory, { recursive: true });
  }
}

/** Delegates installation and lock ownership. Presence checks do not compare upstream revisions. */
export const UpstreamSkills = {
  replacementPolicy() {
    return replacementPolicy;
  },
  install(hosts: Host[], paths: ReturnType<typeof OperatorHome.resolve>) {
    return fromPromise(
      async () => {
        OperatorHome.guardTemporaryTests(
          Environment.read(),
          hosts.map((host) => paths.upstreamSkills[host]),
        );
        return install(hosts);
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap((outcome) => (outcome.detail !== undefined ? Err(outcome) : Ok(outcome)));
  },
  check(paths: ReturnType<typeof OperatorHome.resolve>, host: Host) {
    return fromPromise(
      async () => {
        OperatorHome.guardTemporaryTests(Environment.read(), [paths.upstreamSkills[host]]);
        const missing = [];
        for (const name of required) {
          const file = `${paths.upstreamSkills[host]}/${name}/SKILL.md`;
          try {
            if (!(await stat(file)).isFile() || (await Bun.file(file).text()).trim().length === 0)
              missing.push(file);
          } catch (cause) {
            if (isCodedError(cause) && ["ENOENT", "ENOTDIR", "ELOOP"].includes(cause.code))
              missing.push(file);
            // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
            else throw cause;
          }
        }
        return missing;
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
};
