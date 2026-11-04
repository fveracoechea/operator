import { afterAll, beforeAll, expect, test } from "bun:test";
import { ok, startHerdrServer } from "../../scripts/live-contract-fixture.ts";
import { Herdr } from "./main.ts";

// A live contract: every call reaches the installed Herdr through a private server.
let server: Awaited<ReturnType<typeof startHerdrServer>>;
let repo: string;

beforeAll(async () => {
  server = await startHerdrServer();
  ({ repo } = server);
});
afterAll(async () => {
  await server?.stop();
});

test("herdr workspace, tab, and pane commands answer the shapes Operator reads", async () => {
  const placed = await ok(Herdr.createWorkspace({ cwd: repo, label: "contract" }));
  expect(
    (await ok(Herdr.workspaces())).find((row) => row.workspaceId === placed.workspaceId),
  ).toMatchObject({ label: "contract" });
  expect(await ok(Herdr.pane(placed.paneId))).toEqual({
    tabId: placed.tabId,
    workspaceId: placed.workspaceId,
  });
  await ok(Herdr.renameTab({ tabId: placed.tabId, label: "root label" }));
  const tab = await ok(
    Herdr.createTab({ workspaceId: placed.workspaceId, cwd: repo, label: "second" }),
  );
  expect(await ok(Herdr.tabLabels(placed.workspaceId))).toEqual(["root label", "second"]);
  expect((await ok(Herdr.panes())).find((row) => row.paneId === tab.paneId)).toEqual({
    paneId: tab.paneId,
    tabId: tab.tabId,
    workspaceId: placed.workspaceId,
    cwd: repo,
  });
  expect(await ok(Herdr.agentNames())).toEqual([]);
});

test("herdr pane close closes a pane once, and a closed pane answers pane_not_found", async () => {
  const placed = await ok(Herdr.createWorkspace({ cwd: repo, label: "close" }));
  expect(await ok(Herdr.closePane(placed.paneId))).toBe("closed");
  expect(await ok(Herdr.pane(placed.paneId))).toBeNull();
  expect(await ok(Herdr.closePane(placed.paneId))).toBe("absent");
});

test("herdr worktree create and open place a linked worktree, and worktree remove deletes it", async () => {
  const base = await ok(Herdr.createWorkspace({ cwd: repo, label: "base" }));
  const created = await ok(
    Herdr.createWorktree({
      workspaceId: base.workspaceId,
      branch: "contract-branch",
      label: "tree",
      base: "main",
    }),
  );
  expect(created.path.startsWith(`${server.root}/`)).toBe(true);
  const workspaces = await ok(Herdr.workspaces());
  // Operator finds a project's workspace by the controlling checkout that Herdr reports for it.
  expect(workspaces.find((row) => row.workspaceId === base.workspaceId)).toMatchObject({
    checkout: repo,
    linked: false,
  });
  expect(workspaces.find((row) => row.workspaceId === created.workspaceId)).toMatchObject({
    checkout: created.path,
    linked: true,
  });
  await ok(Herdr.removeWorktree({ workspaceId: created.workspaceId, force: true }));
  expect(await Bun.file(`${created.path}/.git`).exists()).toBe(false);

  Bun.spawnSync([
    "git",
    "-C",
    repo,
    "worktree",
    "add",
    "-q",
    `${server.root}/opened`,
    "-b",
    "opened",
  ]);
  const opened = await ok(
    Herdr.openWorktree({
      workspaceId: base.workspaceId,
      path: `${server.root}/opened`,
      label: "opened",
    }),
  );
  expect(
    (await ok(Herdr.workspaces())).find((row) => row.workspaceId === opened.workspaceId),
  ).toMatchObject({
    checkout: `${server.root}/opened`,
    linked: true,
  });
});

test("herdr plugin link, list, and unlink answer the shapes Operator reads", async () => {
  const directory = `${server.root}/plugin`;
  await Bun.write(
    `${directory}/herdr-plugin.toml`,
    [
      'id = "contract"',
      'name = "Contract"',
      'version = "1.0.0"',
      'min_herdr_version = "0.9.1"',
      'platforms = ["linux", "macos"]',
      "",
    ].join("\n"),
  );
  await ok(Herdr.linkPlugin(directory));
  expect(await ok(Herdr.plugins())).toEqual([{ id: "contract", root: directory }]);
  await ok(Herdr.unlinkPlugin("contract"));
  expect(await ok(Herdr.plugins())).toEqual([]);
});
