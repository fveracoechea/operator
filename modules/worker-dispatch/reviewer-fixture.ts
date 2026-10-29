import { expect, spyOn } from "bun:test";
// Bun has no temporary-directory, realpath, recursive copy, or recursive removal API.
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OkAsync, fromPromise } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { Readiness } from "../readiness/main.ts";
import { pluginManifestFile } from "./plugin.ts";

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: Environment.child(gitEnv),
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

async function commit(checkout: string, text: string) {
  await Bun.write(`${checkout}/file.txt`, text);
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", text);
  return git(checkout, "rev-parse", "HEAD");
}

/**
 * One real origin and checkout per test file. PR 7's head is `head`, a child of `base`.
 * PR 9's head is `forced`, another child of `base` that does not contain `head`.
 */
async function template() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-reviewer-origin-")));
  const origin = `${root}/origin.git`;
  const checkout = `${root}/checkout`;
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, checkout);
  const base = await commit(checkout, "base\n");
  git(checkout, "push", "-q", "origin", "HEAD:refs/heads/main");
  const head = await commit(checkout, "head\n");
  git(checkout, "push", "-q", "origin", "HEAD:refs/pull/7/head");
  git(checkout, "checkout", "-q", "--detach", base);
  const forced = await commit(checkout, "forced\n");
  git(checkout, "push", "-q", "origin", "HEAD:refs/pull/9/head");
  git(checkout, "checkout", "-q", "main");
  return { root, checkout, base, head, forced };
}
let shared: ReturnType<typeof template> | undefined;

/** Removes the shared origin. Call it once after all tests of a file. */
export async function removeReviewerOrigin() {
  const removed = shared;
  shared = undefined;
  if (removed !== undefined) await rm((await removed).root, { recursive: true, force: true });
}

/** A registered project with its own copy of the shared checkout, which fetches from the origin. */
export async function reviewerProject() {
  shared ??= template();
  const { checkout: source, base, head, forced } = await shared;
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-reviewer-")));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  const checkout = `${root}/checkout`;
  await cp(source, checkout, { recursive: true });
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/one",
      checkout,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  await Bun.write(`${paths.herdrPlugin}/herdr-plugin.toml`, Bun.file(pluginManifestFile));
  return { root, paths, checkout, base, head, forced };
}

export function recordPrepared(
  paths: ReturnType<typeof OperatorHome.resolve>,
  worktree: string,
  detail: string,
  state: "prepared" | "failed" = "prepared",
) {
  expect(DeviceState.beginPreparation(paths, worktree, "example/one").tag).toBe("Ok");
  expect(DeviceState.finishPreparation(paths, worktree, { state, detail }).tag).toBe("Ok");
}

/** Module-interface doubles for Herdr and the launch checks. Herdr creates a real worktree. */
export function reviewerDoubles(project: Awaited<ReturnType<typeof reviewerProject>>) {
  const { root, paths, checkout } = project;
  // Git and the launch checks see an isolated Git configuration and a fixed Herdr session.
  const environment = { ...Environment.read(), ...gitEnv, HERDR_SOCKET_PATH: "fixture.sock" };
  spyOn(Environment, "read").mockReturnValue(environment);
  spyOn(Readiness, "check").mockReturnValue(OkAsync({ blockers: [] }));
  spyOn(DeviceSettings, "resolve").mockReturnValue(
    OkAsync({
      host: "claude-code" as const,
      model: "claude-resolved",
      requestedModel: "claude",
      reasoningEffort: "high",
      command: { tool: "claude", args: ["--model", "claude-resolved"] },
      role: "workerAgent" as const,
      profile: "careful",
    }),
  );
  // The worktree hook's outcome, recorded before Herdr answers so the first poll reads it.
  const preparation: { state: "prepared" | "failed"; detail: string } = {
    state: "prepared",
    detail: "fresh ready",
  };
  return {
    preparation,
    githubRemote: spyOn(Projects, "githubRemote").mockReturnValue(OkAsync("origin")),
    plugins: spyOn(Herdr, "plugins").mockReturnValue(
      OkAsync([{ id: "operator", root: paths.herdrPlugin }]),
    ),
    workspaces: spyOn(Herdr, "workspaces").mockReturnValue(
      OkAsync([{ workspaceId: "w1", label: "one", checkout, linked: false }]),
    ),
    agentNames: spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([])),
    tabLabels: spyOn(Herdr, "tabLabels").mockReturnValue(OkAsync([])),
    createWorkspace: spyOn(Herdr, "createWorkspace").mockReturnValue(
      OkAsync({ workspaceId: "w-new", tabId: "t-new", paneId: "p-new" }),
    ),
    createWorktree: spyOn(Herdr, "createWorktree").mockImplementation((input) =>
      fromPromise(
        async () => {
          const worktree = `${root}/worktrees/${input.label}`;
          git(
            checkout,
            "worktree",
            "add",
            "-q",
            "-b",
            input.branch,
            worktree,
            input.base ?? "HEAD",
          );
          recordPrepared(paths, worktree, preparation.detail, preparation.state);
          return { workspaceId: "w2", tabId: "t2", paneId: "p2", path: worktree };
        },
        (cause, defect) => defect(cause),
      ),
    ),
    openWorktree: spyOn(Herdr, "openWorktree").mockReturnValue(
      OkAsync({ workspaceId: "w3", tabId: "t3", paneId: "p3" }),
    ),
    startAgent: spyOn(Herdr, "startAgent").mockReturnValue(OkAsync(null)),
    prompt: spyOn(Herdr, "prompt").mockReturnValue(OkAsync(null)),
  };
}
