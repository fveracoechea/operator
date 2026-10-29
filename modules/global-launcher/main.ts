// Bun has no lstat, stat, real-path, hard-link, mode, or directory creation API.
import { isCodedError } from "../../lib/coded-error.ts";
import { realPathOrNull } from "../../lib/real-path.ts";
import { chmod, link, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fromPromise, Ok, Err } from "unthrown";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import {
  decideLauncher,
  launcherTarget,
  nixLauncherText,
  pinnedSpecifier,
  type Destination,
} from "./plan.ts";

type Installed = {
  reason: "launcher_installed" | "launcher_current";
  data: { command: string; runs: string };
};
type Failure =
  | {
      reason:
        | "launcher_unsupported"
        | "launcher_version_unpinned"
        | "launcher_conflict"
        | "launcher_bun_failed";
      detail: string;
    }
  | ReturnType<typeof qualify<never>>;

const missingCommand =
  "Put the global operator command on PATH. A JSR install needs operator install launcher, a source install needs Bun's global bin folder on PATH, and a Nix install needs the package's bin folder on PATH.";

const runningPackage = Bun.fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const globalManifest = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
});

function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "launcher_global_manifest_invalid" as const, detail: String(cause) };
  if (
    isCodedError(cause) &&
    ["EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "ENOTDIR", "ELOOP"].includes(cause.code)
  )
    return { reason: "launcher_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

async function bun(args: string[]) {
  const result = await ToolInvocation.run({ tool: "bun", args, timeoutMs: 30000 });
  if (
    // Stryker disable next-line ConditionalExpression: equivalent: only a completed run has an exit code, so any other run fails the exit code test too
    result.status === "completed" &&
    result.exitCode === 0
  )
    return result.stdout;
  return null;
}

async function destination(command: string): Promise<Destination> {
  let found;
  try {
    found = await lstat(command);
  } catch (cause) {
    if (isCodedError(cause) && cause.code === "ENOENT") return { absent: true };
    // oxlint-disable-next-line unthrown/no-throw -- Only a missing launcher is modeled here. Qualification handles other I/O.
    throw cause;
  }
  return { absent: false, text: found.isFile() ? await Bun.file(command).text() : null };
}

/** Bun prints its global install folder on the first line, before the dependency tree. */
function globalFolder(listing: string) {
  return /^(.+) node_modules \(/.exec(listing)?.[1] ?? null;
}

/** The specifier the manifest in one install folder records for the alias, if any. */
async function aliasSpecifier(folder: string) {
  const manifest = Bun.file(`${folder}/package.json`);
  if (!(await manifest.exists())) return null;
  return (
    globalManifest.parse(await manifest.json()).dependencies?.[
      OperatorRelease.packageNames().installed
    ] ?? null
  );
}

/** The specifier the manifest beside an installed package records for it, if any. */
async function installedSpecifier(packageRoot: string) {
  const suffix = `/node_modules/${OperatorRelease.packageNames().installed}`;
  if (!packageRoot.endsWith(suffix)) return null;
  return aliasSpecifier(packageRoot.slice(0, -suffix.length));
}

/** Bun's global install folder and the specifier its manifest records for the alias. */
async function globalInstall(listing: string) {
  const reported = globalFolder(listing);
  if (reported === null) return { root: null, specifier: null };
  const resolved = await realPathOrNull(reported);
  const specifier = await aliasSpecifier(reported);
  return { root: resolved === null ? null : { reported, real: resolved }, specifier };
}

type CommandBlocker = {
  reason: "executable_missing" | "executable_mismatch" | "installation_unpinned";
  tool: "operator";
  detail: string;
};

/** Whether the global command found on PATH runs this release, read without running it. */
async function commandBlockers(): Promise<CommandBlocker[]> {
  const found = Bun.which("operator", { PATH: Environment.read().PATH });
  if (found === null)
    return [{ reason: "executable_missing", tool: "operator", detail: missingCommand }];
  const running = await realpath(runningPackage);
  const entries = await Promise.all(
    ["cli.ts", "cli.js"].map((entry) => realPathOrNull(`${running}/${entry}`)),
  );
  // Stryker disable next-line ArrowFunction: no rule: Bun.which found the command, so stat fails only when it is removed during the check
  const entry = await stat(found).catch(() => null);
  // Stryker disable next-line OptionalChaining: no rule: the entry is null only when the command is removed during the check
  const target = entry?.isFile() ? launcherTarget(await Bun.file(found).text()) : null;
  const reached = await Promise.all([found, target ?? found].map((path) => realPathOrNull(path)));
  const blockers: CommandBlocker[] = [];
  if (!reached.some((path) => path !== null && entries.includes(path)))
    blockers.push({
      reason: "executable_mismatch",
      tool: "operator",
      detail: `${found} on PATH does not run this Operator release at ${running}. Hooks and agents would run another release. Remove or replace that command, then reinstall the launcher or the source package.`,
    });
  const specifier = await installedSpecifier(running);
  const { version } = await OperatorRelease.manifest();
  if (specifier !== null && !pinnedSpecifier(specifier, version))
    blockers.push({
      reason: "installation_unpinned",
      tool: "operator",
      detail: `The manifest beside ${running} names ${specifier}, so a Bun update can move the device release. Reinstall with an exact JSR version or a full 40-character source commit.`,
    });
  return blockers;
}

async function facts() {
  const binDirectory = (await bun(["pm", "bin", "-g"]))?.trim();
  const listing = await bun(["pm", "ls", "-g"]);
  if (!binDirectory || listing === null) return null;
  // Tests must not read a person's real global Bun folders either.
  OperatorHome.guardTemporaryTests(Environment.read(), [
    binDirectory,
    globalFolder(listing) ?? binDirectory,
  ]);
  const installed = await globalInstall(listing);
  const release = await OperatorRelease.manifest();
  const command = path.join(binDirectory, "operator");
  return {
    binDirectory,
    decision: decideLauncher({
      packageRoot: await realpath(runningPackage),
      version: release.version,
      built:
        release.artifactIdentity !== null && (await Bun.file(`${runningPackage}/cli.js`).exists()),
      globalRoot: installed.root,
      specifier: installed.specifier,
      command,
      destination: await destination(command),
    }),
  };
}

/** Writes the new file beside the command and links it, so an existing command is never replaced. */
async function write(binDirectory: string, command: string, text: string) {
  await mkdir(binDirectory, { recursive: true });
  const temporary = path.join(binDirectory, `.operator-launcher-${crypto.randomUUID()}`);
  try {
    await Bun.write(temporary, text);
    await chmod(temporary, 0o755);
    await link(temporary, command);
    return true;
  } catch (cause) {
    if (isCodedError(cause) && cause.code === "EEXIST") return false;
    // oxlint-disable-next-line unthrown/no-throw -- Only a concurrent launcher is modeled here. Qualification handles other I/O.
    throw cause;
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Owns the global command. It supplies the launcher for a JSR installation, because the registry drops the package's
 * binary declaration and Bun links none. Source installations already get Bun's binary link, and
 * the Nix package writes its own launcher when it is built.
 */
export const GlobalLauncher = {
  /** The command the Nix package installs, so readiness reads it with the same rules as a JSR launcher. */
  nixText(input: { installRoot: string; bun: string }) {
    return nixLauncherText(input.installRoot, input.bun);
  },
  /** Static readiness facts about the global command and the pin of the running installation. */
  check() {
    return fromPromise(commandBlockers, (cause, defect) =>
      cause instanceof Error ? qualify(cause, defect) : defect(cause),
    );
  },
  install() {
    return fromPromise(
      async () => {
        const gathered = await facts();
        if (gathered === null)
          return Err({
            reason: "launcher_bun_failed" as const,
            detail: "bun pm could not report its global folders. No launcher was written.",
          });
        const { binDirectory, decision } = gathered;
        if (decision.action === "refuse")
          return Err({ reason: decision.reason, detail: decision.detail });
        const data = { command: decision.command, runs: decision.runs };
        if (decision.action === "unchanged")
          return Ok({ reason: "launcher_current" as const, data });
        if (!(await write(binDirectory, decision.command, decision.text)))
          return Err({
            reason: "launcher_conflict" as const,
            detail: `${decision.command} appeared while the launcher was written. It was not changed.`,
          });
        return Ok({ reason: "launcher_installed" as const, data });
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap<Installed, Failure>((result) => result);
  },
};
