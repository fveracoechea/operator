// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";

const jsrScope = "fveracoechea";
const jsrName = "operator";

/** The one home of the package names: JSR's, the npm name JSR serves, and the global alias. */
export const PACKAGE_NAMES = {
  jsrScope,
  jsrName,
  registry: `@jsr/${jsrScope}__${jsrName}`,
  installed: `@${jsrScope}/${jsrName}`,
} as const;

// A stalled registry or command must not hold the publish job, so every process has a bound.
const INSTALL_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;

export type RegistryInstallRequest = {
  /** The npm-compatible registry URL of the `@jsr` scope, for example `https://npm.jsr.io`. */
  registry: string;
  version: string;
  expected: { artifactIdentity: string; commit: string };
  /** The registry builds its npm tarball after a publication, so the install is tried again. */
  attempts: number;
  pauseMs: number;
  /** The bound of one install attempt. Tests shorten it. */
  installTimeoutMs?: number;
};

export type RegistryInstallResult =
  | { status: "verified"; version: string; artifactIdentity: string; attempts: number }
  | { status: "unavailable"; detail: string }
  | { status: "failed"; detail: string }
  | { status: "mismatch"; detail: string };

const versionReport = z.object({
  data: z.looseObject({
    operatorVersion: z.string(),
    commit: z.string().nullable(),
    artifactIdentity: z.string().nullable(),
  }),
});

/** The version report of the installed CLI, or null when its output is not one. */
function readReport(text: string): z.infer<typeof versionReport> | null {
  try {
    const parsed = versionReport.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Runs one command with a bound. A command that the bound stops counts as a failed run. */
async function spawn(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const child = Bun.spawn(command, {
    cwd,
    env: Environment.child(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const stopped =
    child.signalCode === null ? "" : `\nStopped by ${child.signalCode} after ${timeoutMs} ms.`;
  // A command the bound stopped has no zero exit code, so it counts as failed.
  return {
    exitCode: code,
    stdout,
    text: `${stdout}${stderr}${stopped}`.trim().split("\n").slice(-10),
  };
}

/**
 * Installs one exact version from a registry globally in isolated Bun, settings, and state
 * roots, then runs the documented first commands of the installed CLI. The installed release
 * must name the commit and the artifact identity that the publication recorded.
 * Nothing outside one temporary folder changes, and nothing is published.
 */
export async function verifyRegistryInstall(
  request: RegistryInstallRequest,
): Promise<RegistryInstallResult> {
  const root = await mkdtemp(path.join(tmpdir(), "operator-registry-install-"));
  const env = {
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
    BUN_INSTALL: `${root}/bun`,
    BUN_INSTALL_BIN: `${root}/bun/bin`,
    BUN_INSTALL_GLOBAL_DIR: `${root}/bun/install/global`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    await Bun.write(
      `${env.XDG_CONFIG_HOME}/.bunfig.toml`,
      `[install.scopes]\n"@jsr" = ${JSON.stringify(request.registry)}\n`,
    );
    const specifier = `${PACKAGE_NAMES.installed}@npm:${PACKAGE_NAMES.registry}@${request.version}`;
    let attempt = 1;
    // Each attempt gets an empty cache, so a retry reads the registry again and never a cached
    // manifest that predates the publication.
    function install() {
      return spawn(
        [process.execPath, "add", "-g", specifier],
        root,
        { ...env, BUN_INSTALL_CACHE_DIR: `${root}/cache-${attempt}` },
        request.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      );
    }
    let installed = await install();
    // Each later attempt has a fixed number, so the retries are bounded.
    for (const next of Array.from({ length: request.attempts - 1 }, (_, index) => index + 2)) {
      if (installed.exitCode === 0) break;
      await Bun.sleep(request.pauseMs);
      attempt = next;
      installed = await install();
    }
    if (installed.exitCode !== 0)
      return {
        status: "unavailable",
        detail: `bun add -g ${specifier} failed ${attempt} times: ${installed.text.join("\n")}`,
      };

    const cli = `${env.BUN_INSTALL_GLOBAL_DIR}/node_modules/${PACKAGE_NAMES.installed}/cli.js`;
    const checkout = `${root}/checkout`;
    for (const command of [
      ["git", "init", "-q", checkout],
      ["git", "-C", checkout, "remote", "add", "origin", "https://github.com/example/verify.git"],
      [process.execPath, cli, "project", "register", "--json"],
    ]) {
      const result = await spawn(command, command[0] === "git" ? root : checkout, env);
      if (result.exitCode !== 0)
        return {
          status: "failed",
          detail: `${command.join(" ")} failed: ${result.text.join("\n")}`,
        };
    }

    const reported = await spawn([process.execPath, cli, "--version", "--json"], checkout, env);
    const parsed = readReport(reported.stdout);
    if (reported.exitCode !== 0 || parsed === null)
      return {
        status: "failed",
        detail: `The installed version report could not be read: ${reported.text.join("\n")}`,
      };
    const { data } = parsed;
    const expected = { operatorVersion: request.version, ...request.expected };
    const differs = (["operatorVersion", "commit", "artifactIdentity"] as const).filter(
      (key) => data[key] !== expected[key],
    );
    if (differs.length > 0)
      return {
        status: "mismatch",
        detail: differs
          .map((key) => `${key} is ${data[key]}, and the publication recorded ${expected[key]}.`)
          .join(" "),
      };

    return {
      status: "verified",
      version: request.version,
      artifactIdentity: request.expected.artifactIdentity,
      attempts: attempt,
    };
  } finally {
    await rm(root, { recursive: true });
  }
}
