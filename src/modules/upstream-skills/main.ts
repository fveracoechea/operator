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
import { guideReferences } from "./guide-references.ts";

type Host = keyof ReturnType<typeof OperatorHome.resolve>["skillHosts"];
const installerVersion = "1.8.1";
const replacementPolicy =
  "The upstream installer owns replacement and its lock. It can replace local edits without an Operator preview. Inspect a failed or interrupted install before trying again.";
const required = ["code-review"];

type GuideIssue = {
  reason: "guide_skill_unresolved" | "skill_link_unresolved";
  host: Host;
  guide: string;
  skill: string;
  file: string;
  detail: string;
};

async function readableSkill(file: string, optional = false) {
  try {
    return (await stat(file)).isFile() && (await Bun.file(file).text()).trim().length > 0;
  } catch (cause) {
    if (isCodedError(cause) && (optional || ["ENOENT", "ENOTDIR", "ELOOP"].includes(cause.code)))
      return false;
    // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
    throw cause;
  }
}

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

// Each source names one repository. A source with a folder selects only the skill in that folder.
// A source with sections selects every skill under those folders that the release does not own.
const sources: Array<{ repository: string; folder?: string; sections?: string[] }> = [
  { repository: "mattpocock/skills", sections: ["skills/productivity", "skills/engineering"] },
  { repository: "cursor/plugins", folder: "pstack/skills/unslop" },
  { repository: "humanlayer/skills", folder: "plugins/show-me/skills/show-me" },
  { repository: "anthropics/skills", folder: "skills/frontend-design" },
];

async function resolve(directory: string, source: (typeof sources)[number], owned: string[]) {
  const { repository, folder, sections = [] } = source;
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
    for (const section of sections)
      for await (const file of new Bun.Glob(`${section}/**/SKILL.md`).scan({ cwd: checkout }))
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
  /** Static resolution of every built-in guide. Optional show-me links never block a launch. */
  checkGuides(paths: ReturnType<typeof OperatorHome.resolve>, host: Host) {
    return fromPromise(
      async () => {
        OperatorHome.guardTemporaryTests(Environment.read(), [
          paths.skillHosts[host],
          paths.upstreamSkills[host],
        ]);
        const owned = new Set(await OwnedSkills.names());
        const blockers: GuideIssue[] = [];
        const warnings: GuideIssue[] = [];
        for (const { guide, text } of await OwnedSkills.guides()) {
          for (const { name, link } of guideReferences(text)) {
            const optional = name === "show-me" && link !== null;
            const file =
              link === null
                ? `${owned.has(name) ? paths.skillHosts[host] : paths.upstreamSkills[host]}/${name}/SKILL.md`
                : path.resolve(paths.skillHosts[host], path.dirname(guide), link);
            if (await readableSkill(file, optional)) continue;
            const issue: GuideIssue = {
              reason: optional ? "skill_link_unresolved" : "guide_skill_unresolved",
              host,
              guide,
              skill: name,
              file,
              detail: optional
                ? `${guide}: ${link} does not resolve. Read show-me by the absolute path in the brief when available.`
                : `${guide} requires ${name}, but ${file} does not resolve to a readable, nonempty regular file. Provision the skill or ask the SuperAgent; an upstream documentation page is not an installed skill.`,
            };
            (optional ? warnings : blockers).push(issue);
          }
        }
        return { blockers, warnings };
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
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
          if (!(await readableSkill(file))) missing.push(file);
        }
        return missing;
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
};
