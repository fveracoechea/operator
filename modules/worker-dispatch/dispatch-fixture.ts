import { expect, setSystemTime, spyOn } from "bun:test";
// Bun has no temporary-directory, realpath, recursive copy, or recursive removal API.
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
import { WorkSources } from "../work-sources/main.ts";
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

function assignment(key: string, completion: "pr" | "report", dependencies: string[] = []) {
  return {
    key,
    trackerKey: `github:example/one#${key.length}`,
    instructions: `Do the ${key} work.`,
    completion,
    resources: "pane",
    dependencies,
  };
}

function worktree(key: string, completion: "pr" | "report", dependencies: string[] = []) {
  return {
    ...assignment(key, completion, dependencies),
    resources: "worktree",
    branch: `task/${key}`,
  };
}

const plan = {
  trackerKey: "github:example/one#1",
  assignments: [
    assignment("read", "report"),
    { ...worktree("impl", "pr"), profile: "careful" },
    worktree("survey", "report"),
    worktree("parent", "pr"),
    worktree("child", "pr", ["parent"]),
    worktree("notes", "report", ["parent"]),
    assignment("blocked", "report", ["survey"]),
  ],
};

export const resolved = {
  host: "claude-code" as const,
  model: "claude-resolved",
  requestedModel: "claude",
  reasoningEffort: "high",
  command: { tool: "claude", args: ["--model", "claude-resolved"] },
  role: "workerAgent" as const,
  profile: "careful",
};

const base = await realpath(await mkdtemp(path.join(tmpdir(), "operator-dispatch-")));
// Every device lives at the same path, so a copy of the first one keeps its recorded paths.
const root = `${base}/device`;
const template = `${base}/template`;
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
const checkout = `${root}/checkout`;
const socket = `${root}/herdr.sock`;
let sourceId: string | undefined;

/** Builds the registered project and source once, then copies it for each later device. */
async function prepareDevice() {
  await rm(root, { recursive: true, force: true });
  if (sourceId !== undefined) {
    await cp(template, root, { recursive: true });
    return sourceId;
  }
  const remote = `${root}/remote.git`;
  await mkdir(root, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  await Bun.write(`${checkout}/README.md`, "fixture\n", { createPath: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "remote", "add", "origin", "https://github.com/example/one.git");
  git(checkout, "remote", "add", "local", remote);
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fixture");
  expect((await Projects.register({ paths, cwd: checkout })).tag).toBe("Ok");
  await Bun.write(
    paths.config,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/reasoner" },
      profiles: { careful: { reasoningEffort: "high" } },
    }),
    { createPath: true },
  );
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const registered = await WorkSources.register({
    paths,
    cwd: checkout,
    file: `${root}/plan.json`,
  });
  expect(registered).toMatchObject({ tag: "Ok" });
  await Bun.write(`${paths.herdrPlugin}/herdr-plugin.toml`, Bun.file(pluginManifestFile));
  await cp(root, template, { recursive: true });
  sourceId = registered.tag === "Ok" ? registered.value.id : "";
  return sourceId;
}

/** Removes every device of this test file. */
export async function removeDevices() {
  await rm(base, { recursive: true, force: true });
  sourceId = undefined;
}

/**
 * An isolated device with real Git and SQLite, the project `example/one`, and one registered
 * source. Herdr and the launch checks are module-interface doubles. A created worktree is a
 * real Git worktree whose preparation is recorded as the hook would record it.
 * Tests in one file run one at a time, so each device replaces the one before it.
 */
export async function dispatchDevice(options: { deferPreparation?: boolean } = {}) {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    ...gitEnv,
    HERDR_SOCKET_PATH: socket,
  });
  const sourceId = await prepareDevice();

  spyOn(Readiness, "check").mockReturnValue(OkAsync({ blockers: [] }));
  spyOn(DeviceSettings, "resolve").mockReturnValue(OkAsync(resolved));
  spyOn(Herdr, "plugins").mockReturnValue(OkAsync([{ id: "operator", root: paths.herdrPlugin }]));
  const herdr = {
    workspaces: spyOn(Herdr, "workspaces").mockReturnValue(
      OkAsync([{ workspaceId: "w1", label: "one", checkout, linked: false }]),
    ),
    panes: spyOn(Herdr, "panes").mockReturnValue(OkAsync([])),
    renameTab: spyOn(Herdr, "renameTab").mockReturnValue(OkAsync(undefined)),
    agentNames: spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([])),
    tabLabels: spyOn(Herdr, "tabLabels").mockReturnValue(OkAsync([])),
    createWorkspace: spyOn(Herdr, "createWorkspace").mockReturnValue(
      OkAsync({ workspaceId: "w-new", tabId: "t-new", paneId: "p-new" }),
    ),
    createTab: spyOn(Herdr, "createTab").mockReturnValue(OkAsync({ tabId: "t1", paneId: "p1" })),
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
          expect(DeviceState.beginPreparation(paths, worktree, "example/one").tag).toBe("Ok");
          function finish() {
            DeviceState.finishPreparation(paths, worktree, {
              state: "prepared",
              detail: "fresh ready",
            });
          }
          // A deferred hook finishes after Herdr answers, so dispatch waits for its record.
          if (options.deferPreparation) setTimeout(finish, 300);
          else finish();
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

  async function source() {
    const shown = await WorkSources.show({ paths, cwd: checkout, sourceId });
    expect(shown.tag).toBe("Ok");
    return shown.getOr(undefined);
  }

  return {
    root,
    paths,
    checkout,
    sourceId,
    socket,
    herdr,
    request(key: string) {
      return { paths, cwd: checkout, sourceId, assignment: key };
    },
    source,
    /** The recorded launches of one assignment, oldest first. */
    async launches(key: string) {
      return ((await source())?.launches ?? []).filter((launch) => launch.assignment === key);
    },
    /**
     * A reopened worktree reads its preparation once. A second read moves the clock past any
     * wait deadline, so a start that waits for a new preparation ends at once.
     */
    reopening() {
      const read = DeviceState.readPreparation.bind(DeviceState);
      let reads = 0;
      spyOn(DeviceState, "readPreparation").mockImplementation((...args) => {
        reads++;
        if (reads > 1) setSystemTime(Date.now() + 3_600_000);
        return read(...args);
      });
    },
    /** A pane exit as the Herdr hook reports it. */
    exited(paneId: string) {
      expect(
        DeviceState.observePane(paths, {
          socket,
          paneId,
          workspaceId: null,
          observation: { exited: true },
        }).tag,
      ).toBe("Ok");
    },
    /** Agent activity as the Herdr hook reports it. */
    activity(paneId: string, activity: string) {
      expect(
        DeviceState.observePane(paths, {
          socket,
          paneId,
          workspaceId: null,
          observation: { exited: false, activity },
        }).tag,
      ).toBe("Ok");
    },
    /** Records a verified merge of the launch's PR, as `operator pr merge` does. */
    merged(launchId: string, number: number) {
      expect(
        DeviceState.recordPullRequestMerge(
          paths,
          launchId,
          { number, head: "head", mergeCommit: "merge" },
          (rows) => WorkSources.stateAfter(rows),
        ).tag,
      ).toBe("Ok");
    },
    /** Records the open PR of a running launch, as `operator pr associate` does. */
    associate(launchId: string, number: number, branch: string) {
      const url = `https://github.com/example/one/pull/${number}`;
      expect(
        DeviceState.associatePullRequest(paths, launchId, { number, url, branch, relay: null }).tag,
      ).toBe("Ok");
    },
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
