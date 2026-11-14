import { afterEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";
import { z } from "zod";
import { Database } from "bun:sqlite";

let device: Awaited<ReturnType<typeof workerDevice>>;
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

function assignment(key: string, resources: "pane" | "worktree") {
  const planned: {
    key: string;
    trackerKey: string;
    instructions: string;
    completion: string;
    resources: string;
    dependencies: string[];
    branch?: string;
  } = {
    key,
    trackerKey: `APP-${key}`,
    instructions: "Investigate and report.",
    completion: "report",
    resources,
    dependencies: [],
  };
  if (resources === "worktree") planned.branch = `task/${key}`;
  return planned;
}

test("an assignment whose worker and worktree are gone ends, and next actions read the live pane from Herdr", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "APP-1",
    assignments: [assignment("read", "worktree"), assignment("pane", "pane")],
  });
  const worker = await device.dispatch(source, "read");
  const pane = await device.dispatch(source, "pane");
  // Lose the resources without delivering the plugin event. The launch still says running.
  await device.setHerdr({ tabs: [], agents: [], skipHooks: true });
  expect(await device.next("read")).toMatchObject([
    { action: "replace_worker", reason: "worker_interrupted" },
  ]);
  expect(await device.next("pane")).toMatchObject([
    { action: "ended", reason: "assignment_ended", launch: { paneId: pane.paneId } },
  ]);
  await rm(worker.worktreePath ?? "", { recursive: true, force: true });
  expect(await device.next("read")).toMatchObject([
    { action: "ended", reason: "assignment_ended" },
  ]);
  const shown = await device.run(["source", "show", "--source", source]);
  expect(shown.output).toMatchObject({
    data: {
      assignments: [
        { key: "read", state: "abandoned" },
        { key: "pane", state: "abandoned" },
      ],
    },
  });
  expect(await device.herdrCalls()).toContain("pane get");
}, 60000);

test("cleanup ignores ignored entries except changed env files", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "APP-3",
    assignments: [assignment("build", "worktree")],
  });
  const worker = await device.dispatch(source, "build");
  const worktree = worker.worktreePath ?? "";
  // Ignore an entire folder: status must not hide its changed env file.
  const exclude = await device.exec(["git", "rev-parse", "--git-path", "info/exclude"], worktree);
  await Bun.write(exclude.stdout.trim(), "build/\n");
  await Bun.write(`${worktree}/build/out.js`, "generated\n", { createPath: true });
  await Bun.write(`${worktree}/build/.env.production`, "SECRET=changed\n");
  const report = await device.writeJson("report.json", {
    conclusion: "Done",
    evidence: ["Inspected the generated output."],
    unresolved: [],
  });
  expect(
    (await device.run(["report", "submit", "--file", report], { pane: worker.paneId })).code,
  ).toBe(0);
  const args = ["report", "accept", "--source", source, "--assignment", "build"];
  expect(await device.run(args)).toMatchObject({
    code: 0,
    output: { data: { cleanup: { state: "kept" } } },
  });
  expect(await Bun.file(`${worktree}/build/.env.production`).text()).toBe("SECRET=changed\n");
  await rm(`${worktree}/build/.env.production`);
  expect(await device.run(args)).toMatchObject({
    code: 0,
    output: { data: { cleanup: { state: "done" } } },
  });
  expect(await Bun.file(`${worktree}/package.json`).exists()).toBe(false);
}, 60000);

test("abandon ends one assignment and deletes nothing", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "APP-2",
    assignments: [assignment("read", "worktree"), assignment("other", "pane")],
  });
  const worker = await device.dispatch(source, "read");
  const file = `${worker.worktreePath}/notes.md`;
  await Bun.write(file, "unlanded notes\n");
  const before = await device.herdrCalls();
  const abandoned = await device.run(["abandon", "--source", source, "--assignment", "read"]);
  expect(abandoned).toMatchObject({
    code: 0,
    output: {
      reason: "assignment_abandoned",
      data: {
        assignment: "read",
        retained: [{ assignment: "read", worktreePath: worker.worktreePath }],
      },
    },
  });
  expect(await device.herdrCalls()).toEqual(before);
  expect(await Bun.file(file).text()).toBe("unlanded notes\n");
  expect(await device.next("other")).toMatchObject([{ action: "ready_assignment" }]);
  expect(await device.next("read")).toMatchObject([
    { action: "person_decision", reason: "cleanup_unlanded_work" },
  ]);
  expect(await device.run(["dispatch", "--source", source, "--assignment", "read"])).toMatchObject({
    code: 4,
    output: { reason: "assignment_not_dispatchable" },
  });
}, 60000);

test.each(["missing resources", "abandon"])(
  "an ended pr-open assignment names its open PR without closing it after %s",
  async (ending) => {
    device = await workerDevice({ github: true });
    const source = await device.register({
      trackerKey: "APP-4",
      assignments: [{ ...assignment("implement", "worktree"), completion: "pr" }],
    });
    const worker = await device.dispatch(source, "implement");
    const worktree = worker.worktreePath ?? "";
    const head = await device.exec(["git", "rev-parse", "HEAD"], worktree);
    const url = "https://github.com/example/one/pull/7";
    await Bun.write(
      `${device.root}/github.json`,
      JSON.stringify({
        pulls: [
          {
            number: 7,
            url,
            headRefName: "task/implement",
            headRepository: "example/one",
            state: "OPEN",
            head: head.stdout.trim(),
          },
        ],
        branches: { "task/implement": head.stdout.trim() },
      }),
    );
    expect((await device.run(["pr", "associate"], { cwd: worktree })).code).toBe(0);
    const calls = Bun.file(`${device.root}/gh-calls.jsonl`);
    const before = await calls.text();
    if (ending === "abandon") {
      expect(
        await device.run(["abandon", "--source", source, "--assignment", "implement"]),
      ).toMatchObject({
        code: 0,
        output: { data: { retained: [{ pullRequest: url, worktreePath: worktree }] } },
      });
      // No unlanded file is deleted, and the live pane remains untouched.
      expect(await Bun.file(`${worktree}/package.json`).exists()).toBe(true);
    } else {
      await device.setHerdr({ tabs: [], agents: [], skipHooks: true });
      await rm(worktree, { recursive: true, force: true });
    }
    expect(await device.next("implement")).toMatchObject([
      {
        action: ending === "abandon" ? "person_decision" : "ended",
        pullRequest: { url, number: 7 },
      },
    ]);
    expect(await calls.text()).toBe(before);
    const shown = await device.run(["source", "show", "--source", source]);
    expect(shown.output).toMatchObject({
      data: { assignments: [{ state: "abandoned" }], pullRequests: [{ url, mergedAt: null }] },
    });
  },
  60000,
);

test("live panes, moved named agents, and another Herdr session do not end assignments", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "APP-5",
    assignments: [assignment("read", "worktree")],
  });
  const worker = await device.dispatch(source, "read");
  await rm(worker.worktreePath ?? "", { recursive: true, force: true });
  expect(await device.next("read")).toMatchObject([{ action: "wait" }]);
  await device.setHerdr({ tabs: [] });
  // A named agent moved elsewhere still owns the work.
  expect(await device.next("read")).toMatchObject([{ action: "wait" }]);
  await device.setHerdr({ agents: [] });
  const foreign = await device.run(["next"], { socket: `${device.root}/other.sock` });
  const row = z
    .object({
      data: z.object({
        sources: z.array(z.object({ waits: z.array(z.object({ action: z.string() })) })),
      }),
    })
    .parse(foreign.output);
  expect(row.data.sources[0]?.waits[0]?.action).toBe("wait");
  expect(await device.next("read")).toMatchObject([{ action: "ended" }]);
}, 60000);

test("a failed lifecycle probe leaves assignments and launches unchanged", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "APP-6",
    assignments: [assignment("read", "pane")],
  });
  await device.dispatch(source, "read");
  const database = Bun.file(`${device.root}/state/operator/operator.sqlite`);
  const before = await database.bytes();
  await device.setHerdr({ fail: { "pane get": "Herdr unavailable" } });
  expect(await device.run(["next"])).toMatchObject({
    output: { outcome: "refused", reason: "herdr_failed" },
  });
  expect(await database.bytes()).toEqual(before);
}, 60000);

test("a recorded worker end and missing worktree end the assignment even while its terminal pane remains", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "APP-7",
    assignments: [assignment("read", "worktree")],
  });
  const worker = await device.dispatch(source, "read");
  expect((await device.event("pane.exited", { pane_id: worker.paneId })).code).toBe(0);
  await rm(worker.worktreePath ?? "", { recursive: true, force: true });
  expect(await device.next("read")).toMatchObject([
    { action: "ended", reason: "assignment_ended" },
  ]);
}, 60000);

test("a session wait reconciles only its supervised sources", async () => {
  device = await workerDevice();
  const selected = await device.register({
    trackerKey: "APP-8",
    assignments: [assignment("selected", "pane")],
  });
  const other = await device.register({
    trackerKey: "APP-9",
    assignments: [assignment("other", "pane")],
  });
  await device.dispatch(selected, "selected");
  await device.dispatch(other, "other");
  {
    using db = new Database(`${device.root}/state/operator/operator.sqlite`);
    db.query("UPDATE sources SET supervising_session = ? WHERE id = ?").run("ses_scope", selected);
    db.query("UPDATE sources SET supervising_session = ? WHERE id = ?").run("ses_other", other);
  }
  await device.setHerdr({ tabs: [], agents: [], skipHooks: true });
  const waited = await device.exec(
    [
      "env",
      "OPENCODE_SESSION_ID=ses_scope",
      "CLAUDE_CODE_SESSION_ID=",
      "operator",
      "next",
      "--wait",
      "--timeout",
      "0",
      "--json",
    ],
    device.main,
  );
  expect(waited.code, waited.stderr).toBe(0);
  expect(JSON.parse(waited.stdout)).toMatchObject({
    reason: "next_actions_changed",
    data: { sources: [{ id: selected, actions: [{ assignment: "selected", action: "ended" }] }] },
  });
  expect((await device.run(["source", "show", "--source", other])).output).toMatchObject({
    data: { assignments: [{ key: "other", state: "running" }], launches: [{ state: "running" }] },
  });
}, 60000);

test("abandon refusals leave database, resources and external tools unchanged", async () => {
  device = await workerDevice({ github: true });
  const source = await device.register({
    trackerKey: "APP-10",
    assignments: [assignment("read", "worktree")],
  });
  const worker = await device.dispatch(source, "read");
  const args = ["abandon", "--source", source, "--assignment"];
  const database = Bun.file(`${device.root}/state/operator/operator.sqlite`);
  const before = await database.bytes();
  const calls = await device.herdrCalls();
  const githubCalls = Bun.file(`${device.root}/gh-calls.jsonl`);
  const githubBefore = (await githubCalls.exists()) ? await githubCalls.text() : "";
  expect(await device.run([...args, "missing"])).toMatchObject({
    code: 3,
    output: {
      reason: "assignment_not_found",
      next: { command: `operator source show --source ${source}` },
      state: { assignment: "missing" },
    },
  });
  expect(await database.bytes()).toEqual(before);
  expect((await device.run([...args, "read"])).code).toBe(0);
  const ended = await database.bytes();
  expect(await device.run([...args, "read"])).toMatchObject({
    code: 3,
    output: { reason: "assignment_ended", state: { found: "abandoned" } },
  });
  expect(await database.bytes()).toEqual(ended);
  expect(await device.herdrCalls()).toEqual(calls);
  expect(await Bun.file(`${worker.worktreePath}/package.json`).exists()).toBe(true);
  expect((await githubCalls.exists()) ? await githubCalls.text() : "").toBe(githubBefore);
}, 60000);

test("abandon preserves earlier worktrees after a failed pathless replacement and next names the person's retained work", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "APP-11",
    assignments: [assignment("read", "worktree")],
  });
  const worker = await device.dispatch(source, "read");
  const worktree = worker.worktreePath ?? "";
  await Bun.write(`${worktree}/notes.md`, "retained work\n");
  expect((await device.event("pane.exited", { pane_id: worker.paneId })).code).toBe(0);
  await device.setHerdr({ fail: { "worktree open": "Herdr refused" } });
  expect(await device.run(["dispatch", "--source", source, "--assignment", "read"])).toMatchObject({
    code: 1,
    output: { reason: "launch_failed" },
  });
  const calls = await device.herdrCalls();
  expect(await device.run(["abandon", "--source", source, "--assignment", "read"])).toMatchObject({
    code: 0,
    output: { data: { retained: [{ worktreePath: worktree }] } },
  });
  expect(await device.next("read")).toMatchObject([
    {
      action: "person_decision",
      reason: "cleanup_unlanded_work",
      retainedResources: [{ worktreePath: worktree, branch: "task/read" }],
      next: { decider: "person" },
    },
  ]);
  expect(await Bun.file(`${worktree}/notes.md`).text()).toBe("retained work\n");
  expect(await device.herdrCalls()).toEqual(calls);
}, 60000);
