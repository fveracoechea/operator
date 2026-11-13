import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, permission, realpath, symlink, or recursive removal API.
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { Readiness } from "../readiness/main.ts";
import { WorktreePreparation } from "../worktree-preparation/main.ts";
import { ensureWorkspace, launchSettings, preparedAgain } from "./launch-checks.ts";
import { pluginManifestFile } from "./plugin.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

let root = "";
let paths: ReturnType<typeof OperatorHome.resolve>;

const resolved = {
  host: "opencode" as const,
  model: "test/reasoner",
  requestedModel: "reasoner",
  reasoningEffort: "high",
  command: { tool: "opencode", args: ["mini"] },
  role: "workerAgent" as const,
  profile: "careful",
};

function session(socket: string | undefined) {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: socket,
  });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-launch-checks-")));
  paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  await Bun.write(`${paths.herdrPlugin}/herdr-plugin.toml`, Bun.file(pluginManifestFile));
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/one",
      checkout: root,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  session("/run/herdr.sock");
  spyOn(Readiness, "check").mockReturnValue(OkAsync({ blockers: [] }));
  spyOn(Herdr, "plugins").mockReturnValue(
    OkAsync([
      { id: "other", root },
      { id: "operator", root: paths.herdrPlugin },
    ]),
  );
  spyOn(DeviceSettings, "resolve").mockReturnValue(OkAsync(resolved));
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test("a ready start snapshots its socket, launch, release, and skills", async () => {
  const resolve = spyOn(DeviceSettings, "resolve");
  const manifest = await OperatorRelease.manifest();
  expect(await launchSettings(paths, "/checkout", "careful")).toMatchObject({
    tag: "Ok",
    value: {
      herdrSocket: "/run/herdr.sock",
      launch: resolved,
      release: {
        version: manifest.version,
        commit: manifest.commit,
        artifactIdentity: manifest.artifactIdentity,
      },
      skills: await OwnedSkills.identities(),
    },
  });
  expect(resolve).toHaveBeenCalledWith({
    paths,
    cwd: "/checkout",
    role: "workerAgent",
    profile: "careful",
  });
});

test("readiness checks the host that the worker launch resolves to", async () => {
  const check = spyOn(Readiness, "check");
  spyOn(DeviceSettings, "resolve").mockReturnValue(
    OkAsync({ ...resolved, host: "claude-code" as const }),
  );
  expect(await launchSettings(paths, "/checkout", "careful")).toMatchObject({ tag: "Ok" });
  expect(check).toHaveBeenCalledWith(paths, { host: "claude-code" });
});

test("the release snapshot holds only its version, commit, and artifact identity", async () => {
  spyOn(OperatorRelease, "manifest").mockResolvedValue({
    ...(await OperatorRelease.manifest()),
    version: "9.9.9",
    commit: "abc",
    artifactIdentity: "sha256:1",
  });
  const settings = await launchSettings(paths, "/checkout", undefined);
  expect(settings.getOr(null)?.release).toEqual({
    version: "9.9.9",
    commit: "abc",
    artifactIdentity: "sha256:1",
  });
});

test("a start outside a Herdr session is refused before any other check", async () => {
  mock.restore();
  session(undefined);
  const check = spyOn(Readiness, "check");
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: {
      reason: "herdr_session_required",
      detail:
        "Run this command in a pane of the Herdr session that holds the project workspace. Nothing was launched.",
    },
  });
  expect(check).not.toHaveBeenCalled();
});

test("static readiness blockers refuse the start and name each blocker", async () => {
  spyOn(Readiness, "check").mockReturnValue(
    OkAsync({
      blockers: [
        { reason: "github_auth_failed" as const, detail: "a" },
        { reason: "host_unconfigured" as const, detail: "b" },
      ],
    }),
  );
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: {
      reason: "worker_not_ready",
      detail:
        "Static readiness failed: github_auth_failed, host_unconfigured. Run operator ready. Nothing was launched.",
    },
  });
});

const missing = {
  reason: "herdr_plugin_missing",
  detail: "Run operator herdr install so new worktrees are prepared. Nothing was launched.",
};
const outdated = {
  reason: "herdr_plugin_outdated",
  detail:
    "The linked Herdr plugin is not the manifest of this release. Run operator herdr install. Nothing was launched.",
};

test("a plugin that Herdr does not link from the device folder is missing", async () => {
  const plugins = spyOn(Herdr, "plugins");
  for (const listed of [
    [{ id: "other", root: paths.herdrPlugin }],
    [{ id: "operator", root }],
    [{ id: "operator", root: `${root}/gone` }],
  ]) {
    plugins.mockReturnValue(OkAsync(listed));
    expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
      tag: "Err",
      error: missing,
    });
  }
  plugins.mockReturnValue(OkAsync([{ id: "operator", root: paths.herdrPlugin }]));
  await rm(paths.herdrPlugin, { recursive: true });
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: missing,
  });
});

test("a linked folder through a symbolic link is the device folder", async () => {
  await symlink(paths.herdrPlugin, `${root}/link`);
  spyOn(Herdr, "plugins").mockReturnValue(OkAsync([{ id: "operator", root: `${root}/link` }]));
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({ tag: "Ok" });
});

test("a linked manifest that is gone or not this release's is outdated", async () => {
  await Bun.write(`${paths.herdrPlugin}/herdr-plugin.toml`, 'id = "operator"\n');
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: outdated,
  });
  await rm(`${paths.herdrPlugin}/herdr-plugin.toml`);
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: outdated,
  });
});

test.skipIf(asRoot)("a linked manifest that cannot be read is a filesystem failure", async () => {
  await chmod(`${paths.herdrPlugin}/herdr-plugin.toml`, 0o000);
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: { reason: "dispatch_io_failed" },
  });
});

test("a Herdr plugin list failure passes through", async () => {
  const failure = { reason: "herdr_unavailable" as const, detail: "gone" };
  spyOn(Herdr, "plugins").mockReturnValue(ErrAsync(failure));
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: failure,
  });
});

test("a release or skill read that fails on the filesystem is qualified", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const expected = { reason: "dispatch_io_failed", detail: "Error: denied" };
  const manifest = spyOn(OperatorRelease, "manifest").mockRejectedValue(denied);
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: expected,
  });
  manifest.mockRejectedValue("stopped");
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Defect",
    cause: "stopped",
  });
  manifest.mockRestore();
  const identities = spyOn(OwnedSkills, "identities").mockRejectedValue(denied);
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Err",
    error: expected,
  });
  identities.mockRejectedValue("stopped");
  expect(await launchSettings(paths, "/checkout", undefined)).toMatchObject({
    tag: "Defect",
    cause: "stopped",
  });
});

test("a missing project workspace is created, and it and its root tab are named after the repository", async () => {
  const create = spyOn(Herdr, "createWorkspace").mockReturnValue(
    OkAsync({ workspaceId: "w9", tabId: "t9", paneId: "p9" }),
  );
  const rename = spyOn(Herdr, "renameTab").mockReturnValue(OkAsync(undefined));
  expect(await ensureWorkspace("/checkout", "example/team/one", null)).toMatchObject({
    tag: "Ok",
    value: "w9",
  });
  expect(create).toHaveBeenCalledWith({ cwd: "/checkout", label: "one" });
  expect(rename).toHaveBeenCalledWith({ tabId: "t9", label: "one" });
  expect(await ensureWorkspace("/checkout", "example/one", "w1")).toMatchObject({
    tag: "Ok",
    value: "w1",
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(rename).toHaveBeenCalledTimes(1);
});

test("a root tab rename that Herdr refuses fails the workspace start", async () => {
  spyOn(Herdr, "createWorkspace").mockReturnValue(
    OkAsync({ workspaceId: "w9", tabId: "t9", paneId: "p9" }),
  );
  const failure = { reason: "herdr_failed" as const, detail: "herdr tab rename exited 1: refused" };
  spyOn(Herdr, "renameTab").mockReturnValue(ErrAsync(failure));
  expect(await ensureWorkspace("/checkout", "example/one", null)).toMatchObject({
    tag: "Err",
    error: failure,
  });
});

function record(worktree: string, state: string) {
  expect(DeviceState.beginPreparation(paths, worktree, "example/one").tag).toBe("Ok");
  if (state !== "running")
    expect(
      DeviceState.finishPreparation(paths, worktree, {
        state: state === "prepared" ? "prepared" : "failed",
        detail: `earlier ${state}`,
      }).tag,
    ).toBe("Ok");
}

test("a reopened worktree that its earlier start prepared is not prepared again", async () => {
  const worktree = `${root}/worktree`;
  await mkdir(worktree);
  record(worktree, "prepared");
  const prepare = spyOn(WorktreePreparation, "prepare");
  expect(await preparedAgain(paths, `${worktree}/.`)).toMatchObject({
    tag: "Ok",
    value: "earlier prepared",
  });
  expect(prepare).not.toHaveBeenCalled();
});

test("a reopened worktree with no finished preparation is prepared now", async () => {
  const worktree = `${root}/worktree`;
  await mkdir(worktree);
  const prepare = spyOn(WorktreePreparation, "prepare").mockReturnValue(
    OkAsync({
      reason: "worktree_prepared",
      data: { worktree, repository: "example/one", detail: "Copied 1 file." },
    }),
  );
  expect(await preparedAgain(paths, worktree)).toMatchObject({
    tag: "Ok",
    value: "Copied 1 file.",
  });
  expect(prepare).toHaveBeenCalledWith({ paths, worktree });
  record(worktree, "failed");
  prepare.mockReturnValue(OkAsync({ reason: "worktree_unregistered", data: { worktree } }));
  expect(await preparedAgain(paths, worktree)).toMatchObject({
    tag: "Ok",
    value: "worktree_unregistered",
  });
  prepare.mockReturnValue(ErrAsync({ reason: "preparation_failed", detail: "install failed" }));
  expect(await preparedAgain(paths, worktree)).toMatchObject({
    tag: "Err",
    error: { reason: "worktree_setup_failed", detail: "install failed" },
  });
});

test("a missing reopened worktree or unreadable state is refused", async () => {
  expect(await preparedAgain(paths, `${root}/gone`)).toMatchObject({
    tag: "Err",
    error: {
      reason: "worktree_missing",
      detail: `The recorded worktree ${root}/gone no longer exists.`,
    },
  });
  const failure = { reason: "state_busy" as const, detail: "locked" };
  spyOn(DeviceState, "readPreparation").mockReturnValue(Err(failure));
  const prepare = spyOn(WorktreePreparation, "prepare");
  expect(await preparedAgain(paths, root)).toMatchObject({ tag: "Err", error: failure });
  expect(prepare).not.toHaveBeenCalled();
  spyOn(DeviceState, "readPreparation").mockReturnValue(Ok(null));
  // Preparation answers its failures as values, so a throw is a defect.
  const cause = new Error("bug");
  prepare.mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- A programming defect inside the preparation call.
    throw cause;
  });
  expect(await preparedAgain(paths, root)).toMatchObject({ tag: "Defect", cause });
});
