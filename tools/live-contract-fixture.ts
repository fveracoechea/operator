import { expect, spyOn } from "bun:test";
// Bun has no directory creation, temporary-directory, real-path, or recursive removal API.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Result } from "unthrown";
import { Environment } from "../src/modules/environment/main.ts";

/** The Ok value of a vendor call. A refusal fails the test with the vendor's answer. */
export async function ok<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  if (result.tag === "Err") return expect.unreachable(JSON.stringify(result.error));
  if (result.tag === "Defect") return expect.unreachable(String(result.cause));
  return result.value;
}

/** Whether Git created the repository with one commit on main. */
async function initRepository(repo: string) {
  await mkdir(repo);
  return [
    ["init", "-q", "-b", "main"],
    [
      "-c",
      "user.name=Operator",
      "-c",
      "user.email=operator@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
  ].every((args) => Bun.spawnSync(["git", "-C", repo, ...args]).exitCode === 0);
}

/**
 * Starts a private Herdr server for a live contract test and points every Herdr call of this
 * test process at it. Herdr keeps plugin links for all sessions in its config folder, so the
 * server gets its own config folder, and its own home holds the worktrees it creates. The
 * person's Herdr session, its plugins, and its panes stay untouched.
 */
export async function startHerdrServer() {
  // A short root keeps the socket path under the 104-byte Unix socket limit of macOS.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "op-herdr-")));
  const socket = `${root}/config/herdr/herdr.sock`;
  // A caller pane's identity would make Herdr resolve defaults against the person's session.
  const isolated = {
    XDG_CONFIG_HOME: `${root}/config`,
    HERDR_SOCKET_PATH: socket,
    HERDR_ENV: undefined,
    HERDR_PANE_ID: undefined,
    HERDR_TAB_ID: undefined,
    HERDR_WORKSPACE_ID: undefined,
  };
  const herdr = Bun.which("herdr", { PATH: Environment.read().PATH });
  if (herdr === null) {
    await rm(root, { recursive: true, force: true });
    // oxlint-disable-next-line unthrown/no-throw -- A live contract cannot run without the vendor command.
    throw new Error("herdr is not on PATH, so the Herdr contract cannot run.");
  }
  const repo = `${root}/repo`;
  // A failed setup step before the server starts leaves no server or spy to clean up.
  if (!(await initRepository(repo))) {
    await rm(root, { recursive: true, force: true });
    // oxlint-disable-next-line unthrown/no-throw -- The contract has no repository to run against.
    throw new Error(`Git could not create the contract repository in ${repo}.`);
  }
  const server = Bun.spawn([herdr, "server"], {
    cwd: root,
    // The server takes its socket from the config folder, not from a caller's socket path.
    env: Environment.child({ ...isolated, HOME: root, HERDR_SOCKET_PATH: undefined }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const env = Environment.child(isolated);
  function answers(command: string) {
    return (
      Bun.spawnSync([command, "workspace", "list"], { env, stdout: "ignore", stderr: "ignore" })
        .exitCode === 0
    );
  }
  const deadline = Date.now() + 15000;
  while (!answers(herdr)) {
    if (server.exitCode !== null || Date.now() > deadline) {
      server.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
      // oxlint-disable-next-line unthrown/no-throw -- The contract has no server to run against.
      throw new Error(`The private Herdr server did not answer on ${socket}.`);
    }
    await Bun.sleep(100);
  }
  // The spy is the last step, so no failure path leaves it in place for the next contract file.
  const child = Environment.child.bind(Environment);
  const spy = spyOn(Environment, "child").mockImplementation((overrides) =>
    child({ ...isolated, ...overrides }),
  );
  return {
    root,
    socket,
    /** A Git repository with one commit on main, for workspaces and worktrees. */
    repo,
    async stop() {
      // Contract files share one process, so the next file starts from the real environment.
      spy.mockRestore();
      Bun.spawnSync([herdr, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" });
      const stopped = await Promise.race([server.exited, Bun.sleep(5000).then(() => null)]);
      if (stopped === null) server.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    },
  };
}
