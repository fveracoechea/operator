import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no permission or recursive directory removal API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";
import { fakeGithubScript } from "./github-fixture.ts";

type Device = Awaited<ReturnType<typeof workerDevice>>;
let device: Device | undefined;
const panes = new Map<string, string>();
const githubState = z.looseObject({ pulls: z.array(z.looseObject({ number: z.number() })) });
const sourceState = z.object({
  data: z.object({
    launches: z.array(
      z.looseObject({
        id: z.string(),
        assignment: z.string(),
        state: z.string(),
        paneId: z.string().nullable(),
        kind: z.object({ name: z.string() }).nullable(),
      }),
    ),
    pullRequests: z.array(
      z.looseObject({ assignment: z.string(), readiness: z.unknown(), relay: z.unknown() }),
    ),
    stackOperations: z.array(
      z.looseObject({
        id: z.string(),
        launchId: z.string(),
        reviewHistory: z.string().nullable(),
        data: z.unknown(),
      }),
    ),
  }),
});

afterEach(async () => {
  if (device !== undefined) await rm(device.root, { recursive: true, force: true });
  device = undefined;
  panes.clear();
});

async function git(cwd: string, ...args: string[]) {
  const answer = await (device as Device).exec(["git", ...args], cwd);
  expect(answer.code, answer.stderr).toBe(0);
  return answer.stdout.trim();
}

async function github(change: (state: z.infer<typeof githubState>) => void) {
  const file = Bun.file(`${(device as Device).root}/github.json`);
  const state = githubState.parse(await file.json());
  change(state);
  await Bun.write(file, JSON.stringify(state));
}

async function shown(source: string) {
  const result = await (device as Device).run(["source", "show", "--source", source]);
  expect(result.code, result.stderr).toBe(0);
  return sourceState.parse(result.output).data;
}

async function feedback(source: string, key: string, cwd: string) {
  let owner: z.infer<typeof sourceState>["data"]["launches"][number] | undefined;
  for (let count = 0; count < 100 && owner === undefined; count++) {
    const latest = (await shown(source)).launches.findLast((row) => row.assignment === key);
    if (latest?.state === "running" && latest.kind?.name === "pr-feedback") owner = latest;
    else await Bun.sleep(100);
  }
  expect(owner?.paneId).toBeString();
  panes.set(cwd, owner?.paneId ?? "");
  return owner;
}

async function setup(keys: { key: string; dependencies: string[] }[]) {
  device = await workerDevice();
  const remote = `${device.root}/remote.git`;
  await git(device.root, "init", "-q", "--bare", "-b", "main", remote);
  await git(device.main, "remote", "set-url", "origin", remote);
  await git(device.main, "remote", "add", "github", "https://github.com/example/one.git");
  await git(device.main, "push", "-qu", "origin", "main");
  await Bun.write(`${device.root}/tools/gh`, fakeGithubScript(device.root));
  await chmod(`${device.root}/tools/gh`, 0o755);
  await Bun.write(`${device.root}/github.json`, JSON.stringify({ remote, pulls: [] }));
  return device.register({
    trackerKey: "github:example/one#1",
    internalReview: false,
    assignments: keys.map((row, index) => ({
      ...row,
      trackerKey: `github:example/one#${index + 2}`,
      instructions: `Implement ${row.key}.`,
      kind: "implementation",
      branch: `task/${row.key}`,
    })),
  });
}

async function open(source: string, key: string, number: number, base: string, associate = true) {
  const launched = await (device as Device).dispatch(source, key);
  const cwd = launched.worktreePath ?? "";
  await Bun.write(`${cwd}/${key}.txt`, `${key}\n`);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", key);
  await git(cwd, "push", "-qu", "origin", `task/${key}`);
  await github((state) =>
    state.pulls.push({
      number,
      url: `https://github.com/example/one/pull/${number}`,
      headRefName: `task/${key}`,
      headRepository: "example/one",
      state: "OPEN",
      baseRefName: base,
    }),
  );
  panes.set(cwd, launched.paneId);
  if (associate) {
    const associated = await (device as Device).run(["pr", "associate"], {
      cwd,
      pane: launched.paneId,
    });
    expect(associated.code, associated.stderr).toBe(0);
    await feedback(source, key, cwd);
  }
  return cwd;
}

test("wrong-base association refuses without dropping either prerequisite or enabling a partial-parent merge", async () => {
  const source = await setup([
    { key: "parent", dependencies: [] },
    { key: "sibling", dependencies: [] },
    { key: "child", dependencies: ["parent", "sibling"] },
  ]);
  const parent = await open(source, "parent", 6, "main");
  await open(source, "sibling", 9, "main");
  const child = await open(source, "child", 8, "task/parent", false);
  const target = await git(child, "rev-parse", "HEAD^");
  const base = `operator/stacks/${source}/child/${target}`;
  const before = (await shown(source)).pullRequests;
  const refused = await (device as Device).run(["pr", "associate"], {
    cwd: child,
    pane: panes.get(child),
  });
  expect(refused.output.reason).toBe("pr_base_invalid");
  expect((await shown(source)).pullRequests).toEqual(before);
  await github((state) => {
    const pr = state.pulls.find((row) => row.number === 8);
    if (pr !== undefined) pr.baseRefName = base;
  });
  const associated = await (device as Device).run(["pr", "associate"], {
    cwd: child,
    pane: panes.get(child),
  });
  expect(associated.code, associated.stderr).toBe(0);
  await feedback(source, "child", child);
  const pr = (await shown(source)).pullRequests.find((row) => row.assignment === "child");
  expect(pr?.relay).toMatchObject({
    cut: target,
    base,
    prerequisites: [{ assignment: "parent" }, { assignment: "sibling" }],
  });
  const readiness = pr?.readiness;
  await git(parent, "push", "-q", "origin", "HEAD:refs/heads/main");
  await github((state) => {
    const first = state.pulls.find((row) => row.number === 6);
    if (first !== undefined) first.state = "MERGED";
    const current = state.pulls.find((row) => row.number === 8);
    if (current !== undefined)
      Object.assign(current, {
        reviewDecision: "APPROVED",
        reviews: [{ id: "review", state: "APPROVED", author: "reviewer" }],
        checks: [{ name: "targeted", conclusion: "SUCCESS" }],
      });
  });
  const waited = await (device as Device).run(["pr", "wait", "--timeout", "0"], {
    cwd: child,
    pane: panes.get(child),
  });
  expect(waited.code, waited.stderr).toBe(0);
  const result = z
    .object({
      data: z.object({
        mergeConditions: z.object({ defaultBase: z.boolean(), stackRelayed: z.boolean() }),
        events: z.array(z.looseObject({ kind: z.string() })),
      }),
    })
    .parse(waited.output).data;
  expect(result.mergeConditions).toMatchObject({ defaultBase: false, stackRelayed: false });
  expect(
    result.events.some(
      (event) => event.kind === "merge_eligible" || event.kind === "parent_relayed",
    ),
  ).toBe(false);
  expect(
    (await shown(source)).pullRequests.find((row) => row.assignment === "child")?.readiness,
  ).toEqual(readiness);
  expect(await git(child, "diff", `${target}...HEAD`, "--name-only")).toBe("child.txt");
  const state = githubState.parse(await Bun.file(`${(device as Device).root}/github.json`).json());
  expect(state.pulls.find((row) => row.number === 8)?.baseRefName).toBe(base);
  expect(state.pulls.find((row) => row.number === 9)?.state).toBe("OPEN");
}, 60000);

test("pending supplemental graph cycles refuse before storing the second plan", async () => {
  const source = await setup([
    { key: "root", dependencies: [] },
    { key: "left", dependencies: ["root"] },
    { key: "right", dependencies: ["root"] },
  ]);
  await open(source, "root", 6, "main");
  const left = await open(source, "left", 8, "task/root");
  const right = await open(source, "right", 9, "task/root");
  const first = await (device as Device).run(["pr", "stack", "plan", "--parent", "right"], {
    cwd: left,
  });
  expect(first.code, first.stderr).toBe(0);
  const before = await shown(source);
  const second = await (device as Device).run(["pr", "stack", "plan", "--parent", "left"], {
    cwd: right,
  });
  expect(second.output.reason).toBe("stack_parent");
  expect((await shown(source)).stackOperations).toEqual(before.stackOperations);
  expect(await git(left, "status", "--porcelain")).toBe("");
  expect(await git(right, "status", "--porcelain")).toBe("");
}, 60000);

test("completed integration transfers only its pending review authority to the same-worktree replacement", async () => {
  const source = await setup([
    { key: "parent", dependencies: [] },
    { key: "child", dependencies: ["parent"] },
  ]);
  const parent = await open(source, "parent", 6, "main");
  const child = await open(source, "child", 8, "task/parent");
  await Bun.write(`${parent}/later.txt`, "parent update\n");
  await git(parent, "add", ".");
  await git(parent, "commit", "-qm", "advance parent");
  await git(parent, "push", "-q");
  const planned = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(planned.code, planned.stderr).toBe(0);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(planned.output).data.id;
  expect(
    (await (device as Device).run(["pr", "stack", "apply", "--plan", id], { cwd: child })).code,
  ).toBe(0);
  const original = (await shown(source)).stackOperations.find((row) => row.id === id);
  const head = await git(child, "rev-parse", "HEAD");
  const githubBefore = await Bun.file(`${(device as Device).root}/github.json`).text();
  expect((await (device as Device).event("pane.exited", { pane_id: panes.get(child) })).code).toBe(
    0,
  );
  const replacement = await (device as Device).dispatch(source, "child");
  expect(replacement.worktreePath).toBe(child);
  const resumed = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
    pane: replacement.paneId,
  });
  expect(resumed.code, resumed.stderr).toBe(0);
  const next = z.object({ next: z.object({ command: z.string() }) }).parse(resumed.output)
    .next.command;
  expect(next).toBe(`operator pr stack review --plan ${id}`);
  const recovered = (await shown(source)).stackOperations.find((row) => row.id === id);
  expect(recovered?.reviewHistory).toBe(original?.reviewHistory);
  expect(await git(child, "rev-parse", "HEAD")).toBe(head);
  expect(await Bun.file(`${(device as Device).root}/github.json`).text()).toBe(githubBefore);
  const review = await (device as Device).run(next.split(" ").slice(1), {
    cwd: child,
    pane: replacement.paneId,
  });
  expect(review.output.reason).toBe("stack_review_started");
  {
    using client = new Database(`${(device as Device).root}/state/operator/operator.sqlite`, {
      readonly: true,
    });
    const row = z
      .object({ launch_id: z.string(), review_history: z.string() })
      .parse(
        client.query("SELECT launch_id, review_history FROM stack_operations WHERE id = ?").get(id),
      );
    const owner = z
      .object({ id: z.string() })
      .parse(client.query("SELECT id FROM launches WHERE pane_id = ?").get(replacement.paneId));
    expect(row.launch_id).toBe(owner.id);
    expect(row.review_history).toBe(original?.reviewHistory ?? "");
  }
}, 60000);

test("corrupt operation PR identity refuses before any database, local ref, publication, push, or retarget write", async () => {
  const source = await setup([
    { key: "parent", dependencies: [] },
    { key: "child", dependencies: ["parent"] },
    { key: "sibling", dependencies: [] },
  ]);
  await open(source, "parent", 6, "main");
  const child = await open(source, "child", 8, "task/parent");
  await open(source, "sibling", 9, "main");
  await github((state) => {
    const pr = state.pulls.find((row) => row.number === 8);
    if (pr !== undefined) pr.isDraft = true;
  });
  const planned = await (device as Device).run(["pr", "stack", "plan", "--parent", "sibling"], {
    cwd: child,
  });
  expect(planned.code, planned.stderr).toBe(0);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(planned.output).data.id;
  const database = `${(device as Device).root}/state/operator/operator.sqlite`;
  {
    using client = new Database(database);
    const row = z
      .object({ data: z.string() })
      .parse(client.query("SELECT data FROM stack_operations WHERE id = ?").get(id));
    const data: unknown = JSON.parse(row.data);
    client
      .query("UPDATE stack_operations SET data = ? WHERE id = ?")
      .run(JSON.stringify({ ...z.looseObject({}).parse(data), number: 9 }), id);
  }
  const before = await Bun.file(database).arrayBuffer();
  const refs = await git(child, "for-each-ref", "--format=%(refname) %(objectname)");
  const remote = await git(child, "ls-remote", "origin");
  const head = await git(child, "rev-parse", "HEAD");
  const githubBefore = await Bun.file(`${(device as Device).root}/github.json`).text();
  const invalidRead = await (device as Device).run(["source", "show", "--source", source]);
  expect(invalidRead.output.reason).toBe("state_corrupt");
  const applied = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
  });
  expect(applied.output.reason).toBe("state_corrupt");
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);
  expect(await git(child, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
  expect(await git(child, "ls-remote", "origin")).toBe(remote);
  expect(await git(child, "rev-parse", "HEAD")).toBe(head);
  expect(await git(child, "status", "--porcelain")).toBe("");
  expect(await Bun.file(`${(device as Device).root}/github.json`).text()).toBe(githubBefore);
}, 60000);
