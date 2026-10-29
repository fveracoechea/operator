import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, realpath, symlink, or recursive removal API.
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { z } from "zod";
import { registerTestDevice } from "../../scripts/device-fixture.ts";

let root = "";
const cli = new URL("../../cli.ts", import.meta.url).pathname;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-projects-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: Environment.child({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr, args.join(" ")).not.toContain("fatal:");
  expect(code, stderr).toBe(0);
  return stdout;
}

async function repository(name = "checkout", remote = "git@github.com:Example/One.git") {
  const cwd = `${root}/${name}`;
  await mkdir(cwd, { recursive: true });
  await git(cwd, "init", "-q", "-b", "main");
  if (remote) await git(cwd, "remote", "add", "arbitrary", remote);
  return cwd;
}

async function run(
  cwd: string,
  args = ["register"],
  overrides: Record<string, string | undefined> = {},
  group = "project",
  preload?: string,
) {
  const child = Bun.spawn(
    [process.execPath, ...(preload ? ["--preload", preload] : []), cli, group, ...args, "--json"],
    {
      cwd,
      env: Environment.child({
        HOME: `${root}/home`,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_STATE_HOME: `${root}/state`,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...overrides,
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: JSON.parse(stdout) as unknown, stderr };
}

const projectOutput = z.object({
  data: z.object({ repository: z.string(), checkout: z.string(), registeredAt: z.string() }),
});

test("explicit registration creates one migrated device database and repeats without checkout writes", async () => {
  const cwd = await repository();
  const before = await git(cwd, "status", "--porcelain=v1", "--untracked-files=all");
  const first = await run(cwd);
  expect(first.code, first.stderr).toBe(0);
  expect(first.output).toMatchObject({
    reason: "project_registered",
    data: { repository: "example/one", checkout: cwd },
  });
  const initial = projectOutput.parse(first.output).data;
  expect(Number.isNaN(Date.parse(initial.registeredAt))).toBe(false);
  const repeated = await run(cwd);
  expect(repeated.code, repeated.stderr).toBe(0);
  expect(repeated.output).toMatchObject({ reason: "project_unchanged", data: initial });
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT repository, checkout FROM projects").all()).toEqual([
    { repository: "example/one", checkout: cwd },
  ]);
  expect(db.query("SELECT hash, created_at FROM __drizzle_migrations").all()).toHaveLength(11);
  expect(db.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  expect(await git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
  expect(
    await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: `${root}/state/operator`, onlyFiles: false }),
    ),
  ).toContain("projects/example/one");
  expect(await Bun.file(`${root}/config/operator/config.json`).exists()).toBe(false);
});

test("ordinary project lookup never creates a missing database", async () => {
  const cwd = await repository();
  const result = await run(cwd, ["show"]);
  expect(result).toMatchObject({ code: 3, output: { reason: "state_missing" } });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd, dot: true }))).not.toContain(
    ".operator",
  );
});

test("lists controller status from anywhere without adopting missing or mismatched checkouts", async () => {
  const one = await repository();
  const two = await repository("two", "https://github.com/example/two.git");
  const three = await repository("three", "https://github.com/example/three.git");
  for (const cwd of [one, two, three]) expect((await run(cwd)).code).toBe(0);
  await repository("alternate");
  await rename(two, `${root}/moved-two`);
  await git(three, "remote", "set-url", "arbitrary", "https://github.com/example/renamed.git");
  const database = `${root}/state/operator/operator.sqlite`;
  const before = await Bun.file(database).arrayBuffer();
  expect(await run(root, ["list"])).toMatchObject({
    code: 0,
    output: {
      reason: "projects_listed",
      data: {
        projects: [
          {
            repository: "example/one",
            checkout: one,
            openSources: 0,
            controller: { status: "available" },
          },
          {
            repository: "example/three",
            checkout: three,
            openSources: 0,
            controller: { status: "mismatched" },
          },
          {
            repository: "example/two",
            checkout: two,
            openSources: 0,
            controller: { status: "missing" },
          },
        ],
      },
    },
  });
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);
  expect((await run(`${root}/alternate`, ["show"])).output).toMatchObject({
    reason: "controller_mismatch",
  });
});

test("an inaccessible controller stays blocked while pending removals remain visible", async () => {
  const one = await repository("private/controller");
  const two = await repository("two", "https://github.com/example/two.git");
  for (const cwd of [one, two]) expect((await run(cwd)).code).toBe(0);
  const removed = `${root}/state/operator/projects/example/two`;
  await rename(removed, `${root}/external-state`);
  await Bun.write(`${root}/external-state/keep`, "external content");
  await symlink(`${root}/external-state`, removed);
  expect((await run(root, ["remove", "example/two", "--person-instructed"])).code).toBe(1);
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  await chmod(`${root}/private`, 0o000);
  try {
    expect(await run(root, ["list"])).toMatchObject({
      code: 0,
      output: {
        reason: "projects_listed",
        data: {
          projects: [
            {
              repository: "example/one",
              checkout: one,
              controller: { status: "blocked", reason: "project_io_failed" },
            },
          ],
          pendingRemovals: [{ repository: "example/two" }],
        },
      },
    });
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
    expect(await Bun.file(`${root}/external-state/keep`).text()).toBe("external content");
  } finally {
    await chmod(`${root}/private`, 0o700);
  }
});

test("moves only the same identity to a real main checkout and preserves registration history", async () => {
  const cwd = await repository();
  const alternate = await repository("alternate");
  const initial = projectOutput.parse((await run(cwd)).output).data;
  await rename(cwd, `${root}/old-controller`);
  await mkdir(`${alternate}/nested`);
  await symlink(alternate, `${root}/alias`);
  const before = await git(alternate, "status", "--porcelain=v1", "--untracked-files=all");
  expect(await run(`${root}/alias/nested`, ["move"])).toMatchObject({
    code: 0,
    output: { reason: "project_moved", data: { ...initial, checkout: alternate } },
  });
  expect((await run(alternate, ["show"])).output).toMatchObject({ data: { checkout: alternate } });
  expect((await run(`${root}/old-controller`, ["show"])).output).toMatchObject({
    reason: "controller_mismatch",
  });
  expect(await git(alternate, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
  await git(alternate, "remote", "set-url", "arbitrary", "https://github.com/example/renamed.git");
  const bytes = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  expect((await run(alternate, ["move", "--repository", "example/one"])).output).toMatchObject({
    reason: "repository_choice_invalid",
  });
  expect((await run(alternate, ["move"])).output).toMatchObject({
    reason: "controller_identity_mismatch",
  });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(bytes);
});

test("removes only on explicit instruction, deletes ended history, and preserves repository work and backups", async () => {
  const cwd = await repository();
  expect((await run(cwd)).code).toBe(0);
  await git(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  await git(cwd, "worktree", "add", "-q", "-b", "unfinished", `${root}/retained-worktree`);
  await Bun.write(`${root}/retained-worktree/unlanded.txt`, "keep worktree work");
  const resources = await git(cwd, "worktree", "list", "--porcelain");
  const refs = await git(cwd, "show-ref");
  await Bun.write(`${root}/plan.json`, JSON.stringify({ trackerKey: "ended", assignments: [] }));
  expect((await run(cwd, ["register", "--file", `${root}/plan.json`], {}, "source")).code).toBe(0);
  await Bun.write(`${cwd}/unlanded.txt`, "keep this work");
  await Bun.write(`${root}/state/operator/projects/example/one/report.md`, "old report");
  await Bun.write(`${root}/state/operator/backups/keep/operator.sqlite`, "backup sentinel", {
    createPath: true,
  });
  const database = `${root}/state/operator/operator.sqlite`;
  const before = await Bun.file(database).arrayBuffer();
  expect((await run(root, ["remove", "example/one"])).output).toMatchObject({
    reason: "person_instruction_required",
  });
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);
  expect(
    await run(root, ["remove", "EXAMPLE/ONE", "--person-instructed"], { PATH: `${root}/no-tools` }),
  ).toMatchObject({
    code: 0,
    output: { reason: "project_removed" },
  });
  expect((await run(root, ["list"])).output).toMatchObject({
    data: { projects: [], pendingRemovals: [] },
  });
  using db = new Database(database, { readonly: true });
  expect(db.query("SELECT * FROM sources").all()).toEqual([]);
  expect(db.query("SELECT * FROM assignments").all()).toEqual([]);
  expect(await Bun.file(`${root}/state/operator/projects/example/one/report.md`).exists()).toBe(
    false,
  );
  expect(await Bun.file(`${root}/state/operator/backups/keep/operator.sqlite`).text()).toBe(
    "backup sentinel",
  );
  expect(await Bun.file(`${cwd}/unlanded.txt`).text()).toBe("keep this work");
  expect(await Bun.file(`${root}/retained-worktree/unlanded.txt`).text()).toBe(
    "keep worktree work",
  );
  expect(await git(cwd, "worktree", "list", "--porcelain")).toBe(resources);
  expect(await git(cwd, "show-ref")).toBe(refs);
  expect(await git(cwd, "remote", "get-url", "arbitrary")).toContain("Example/One.git");
  expect((await run(cwd)).code).toBe(0);
});

test("removal is identity-scoped even with a missing controller or changed remote", async () => {
  const one = await repository();
  const two = await repository("two", "https://github.com/example/two.git");
  for (const cwd of [one, two]) expect((await run(cwd)).code).toBe(0);
  await Bun.write(`${root}/state/operator/projects/example/one/old`, "remove one");
  await Bun.write(`${root}/state/operator/projects/example/two/keep`, "preserve two");
  await rename(one, `${root}/relocated`);
  await git(two, "remote", "set-url", "arbitrary", "https://github.com/example/transferred.git");
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  expect(
    await run(root, ["remove", "../unsafe", "--person-instructed"], { PATH: `${root}/no-tools` }),
  ).toMatchObject({ code: 2, output: { reason: "repository_choice_invalid" } });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
  expect((await run(root, ["remove", "example/one", "--person-instructed"])).code).toBe(0);
  expect((await run(root, ["list"])).output).toMatchObject({
    data: { projects: [{ repository: "example/two", controller: { status: "mismatched" } }] },
  });
  expect(await Bun.file(`${root}/state/operator/projects/example/two/keep`).text()).toBe(
    "preserve two",
  );
  expect((await run(root, ["remove", "example/two", "--person-instructed"])).code).toBe(0);
  expect(await git(`${root}/relocated`, "remote", "get-url", "arbitrary")).toContain(
    "Example/One.git",
  );
  expect(await git(two, "remote", "get-url", "arbitrary")).toContain("transferred.git");
});

test("keeps failed cleanup visible after record removal and recovers without deleting linked destinations", async () => {
  const cwd = await repository();
  expect((await run(cwd)).code).toBe(0);
  const owner = `${root}/state/operator/projects/example`;
  await rename(owner, `${root}/preserved`);
  await Bun.write(`${root}/preserved/one/report.md`, "must remain untouched");
  await symlink(`${root}/preserved`, owner);
  expect(await run(root, ["remove", "example/one", "--person-instructed"])).toMatchObject({
    code: 1,
    output: { reason: "project_cleanup_pending" },
  });
  expect((await run(root, ["list"])).output).toMatchObject({
    data: { projects: [], pendingRemovals: [{ repository: "example/one" }] },
  });
  const bytes = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  expect((await run(cwd)).output).toMatchObject({ reason: "project_cleanup_pending" });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(bytes);
  expect(await Bun.file(`${root}/preserved/one/report.md`).text()).toBe("must remain untouched");
  await rm(owner);
  await rename(`${root}/preserved`, owner);
  expect(await run(root, ["remove", "example/one", "--person-instructed"])).toMatchObject({
    code: 0,
    output: { reason: "project_removed" },
  });
  expect((await run(root, ["list"])).output).toMatchObject({
    data: { projects: [], pendingRemovals: [] },
  });
  expect(await Bun.file(`${owner}/one/report.md`).exists()).toBe(false);
});

test("a stale cleanup cannot delete a new registration after another process completes removal", async () => {
  const cwd = await repository();
  expect((await run(cwd)).code).toBe(0);
  const preload = `${root}/hold-cleanup.ts`;
  await Bun.write(
    preload,
    `import { Database } from "bun:sqlite";
import { writeFileSync, existsSync } from "node:fs";
const exec = Database.prototype.exec;
let writes = 0;
Database.prototype.exec = function(sql, ...args) {
  if (sql === "BEGIN IMMEDIATE" && ++writes === 2) {
    writeFileSync(${JSON.stringify(`${root}/cleanup-held`)}, "held");
    const until = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(`${root}/release-cleanup`)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return exec.call(this, sql, ...args);
};`,
  );
  const removing = run(
    root,
    ["remove", "example/one", "--person-instructed"],
    {},
    "project",
    preload,
  );
  try {
    for (
      let attempt = 0;
      attempt < 500 && !(await Bun.file(`${root}/cleanup-held`).exists());
      attempt++
    )
      await Bun.sleep(10);
    expect(await Bun.file(`${root}/cleanup-held`).exists()).toBe(true);
    expect((await run(cwd)).output).toMatchObject({ reason: "project_cleanup_pending" });
    expect((await run(root, ["remove", "example/one", "--person-instructed"])).code).toBe(0);
    expect((await run(cwd)).code).toBe(0);
    await Bun.write(`${root}/state/operator/projects/example/one/new-generation`, "keep new state");
  } finally {
    await Bun.write(`${root}/release-cleanup`, "continue");
  }
  expect(await removing).toMatchObject({ code: 0, output: { reason: "project_removed" } });
  expect(await Bun.file(`${root}/state/operator/projects/example/one/new-generation`).text()).toBe(
    "keep new state",
  );
  expect((await run(cwd, ["show"])).code).toBe(0);
});

test("an I/O cleanup failure retains its obligation and recovers in a later CLI process", async () => {
  const cwd = await repository();
  expect((await run(cwd)).code).toBe(0);
  const directory = `${root}/state/operator/projects/example/one`;
  await Bun.write(`${directory}/report`, "report");
  await chmod(`${root}/state/operator/projects/example`, 0o500);
  try {
    expect(await run(root, ["remove", "example/one", "--person-instructed"])).toMatchObject({
      code: 1,
      output: { reason: "project_cleanup_pending" },
    });
    expect((await run(root, ["list"], { PATH: `${root}/no-tools` })).output).toMatchObject({
      data: { projects: [], pendingRemovals: [{ repository: "example/one" }] },
    });
  } finally {
    await chmod(`${root}/state/operator/projects/example`, 0o700);
  }
  expect((await run(root, ["remove", "example/one", "--person-instructed"])).code).toBe(0);
  expect(await Bun.file(`${directory}/report`).exists()).toBe(false);
});

test("project file cleanup holds the writer reservation until deletion and obligation completion", async () => {
  const cwd = await repository();
  expect((await run(cwd)).code).toBe(0);
  const preload = `${root}/reserved-cleanup.ts`;
  await Bun.write(
    preload,
    `import { Database } from "bun:sqlite";
import { writeFileSync, existsSync } from "node:fs";
const exec = Database.prototype.exec;
let transactions = 0;
Database.prototype.exec = function(sql, ...args) {
  const result = exec.call(this, sql, ...args);
  if ((sql === "BEGIN IMMEDIATE" || sql === "BEGIN") && ++transactions === 3) {
    writeFileSync(${JSON.stringify(`${root}/reserved`)}, "held");
    const until = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(`${root}/release`)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return result;
};`,
  );
  const removing = run(
    root,
    ["remove", "example/one", "--person-instructed"],
    {},
    "project",
    preload,
  );
  try {
    for (
      let attempt = 0;
      attempt < 500 && !(await Bun.file(`${root}/reserved`).exists());
      attempt++
    )
      await Bun.sleep(10);
    expect(await Bun.file(`${root}/reserved`).exists()).toBe(true);
    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Database } from "bun:sqlite"; using db = new Database(${JSON.stringify(`${root}/state/operator/operator.sqlite`)}); db.exec("PRAGMA busy_timeout = 20"); db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK");`,
      ],
      { env: Environment.child(), stdout: "pipe", stderr: "pipe" },
    );
    expect(await writer.exited).not.toBe(0);
    expect(await new Response(writer.stderr).text()).toContain("database is locked");
  } finally {
    await Bun.write(`${root}/release`, "continue");
  }
  expect((await removing).code).toBe(0);
});

test("open sources block move and removal atomically without repository or state-file effects", async () => {
  const cwd = await repository();
  const alternate = await repository("alternate");
  expect((await run(cwd)).code).toBe(0);
  await Bun.write(
    `${root}/plan.json`,
    JSON.stringify({
      trackerKey: "open",
      assignments: [
        {
          key: "task",
          trackerKey: "TASK-1",
          instructions: "Read only",
          completion: "report",
          resources: "pane",
          dependencies: [],
        },
      ],
    }),
  );
  expect((await run(cwd, ["register", "--file", `${root}/plan.json`], {}, "source")).code).toBe(0);
  await Bun.write(`${root}/state/operator/projects/example/one/brief.md`, "preserve brief");
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  for (const [where, args] of [
    [alternate, ["move"]],
    [root, ["remove", "example/one", "--person-instructed"]],
  ] as const) {
    expect(await run(where, [...args])).toMatchObject({
      code: 3,
      output: { reason: "project_source_open" },
    });
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
    expect(await Bun.file(`${root}/state/operator/projects/example/one/brief.md`).text()).toBe(
      "preserve brief",
    );
  }
  expect((await run(root, ["list"])).output).toMatchObject({
    data: { projects: [{ checkout: cwd, openSources: 1 }] },
  });
  expect(await git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  expect(await git(alternate, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
});

test("move refuses linked, bare, legacy, and unrelated destinations without changing state", async () => {
  const cwd = await repository();
  expect((await run(cwd)).code).toBe(0);
  await git(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  await git(cwd, "worktree", "add", "-q", "--detach", `${root}/linked`);
  await git(root, "init", "--bare", "-q", `${root}/bare`);
  const legacy = await repository("legacy");
  await Bun.write(`${legacy}/.operator/keep`, "old state", { createPath: true });
  const unrelated = await repository("unrelated", "https://github.com/example/other.git");
  const before = await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer();
  for (const [where, reason] of [
    [`${root}/linked`, "linked_checkout"],
    [`${root}/bare`, "bare_repository"],
    [legacy, "legacy_project_state"],
    [unrelated, "project_not_registered"],
  ]) {
    expect(where).toBeDefined();
    expect((await run(where ?? root, ["move"])).output).toMatchObject({ reason });
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(before);
  }
  expect(await Bun.file(`${legacy}/.operator/keep`).text()).toBe("old state");
  expect(await git(cwd, "worktree", "list", "--porcelain")).toContain(`${root}/linked`);
});

test("resolves a subdirectory and a symlink to the real controlling checkout", async () => {
  const cwd = await repository();
  await mkdir(`${cwd}/nested`);
  await symlink(cwd, `${root}/alias`);
  expect((await run(`${root}/alias/nested`)).code).toBe(0);
  const shown = await run(`${root}/alias/nested`, ["show"]);
  expect(shown).toMatchObject({
    code: 0,
    output: { reason: "project_resolved", data: { checkout: cwd, repository: "example/one" } },
  });
});

test("requires a matching repository choice for multiple identities, without trusting remote names", async () => {
  const cwd = await repository();
  await git(cwd, "remote", "add", "origin", "https://github.com/Fork/Two.git");
  expect((await run(cwd)).output).toMatchObject({ reason: "repository_choice_required" });
  expect((await run(cwd, ["register", "--repository", "missing/three"])).code).toBe(2);
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
  const chosen = await run(cwd, ["register", "--repository", "EXAMPLE/ONE"]);
  expect(chosen).toMatchObject({ code: 0, output: { data: { repository: "example/one" } } });
  expect((await run(cwd, ["show"])).code).toBe(0);
});

test.each([
  "",
  "https://gitlab.com/example/one.git",
  "https://github.com.evil.test/example/one.git",
])("refuses a missing GitHub identity %s with no device writes", async (remote) => {
  const cwd = await repository("checkout", remote);
  expect(await run(cwd)).toMatchObject({ code: 3, output: { reason: "github_remote_missing" } });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
});

test("refuses alternate clones and a changed controller identity without adoption", async () => {
  const cwd = await repository();
  const other = await repository("other");
  expect((await run(cwd)).code).toBe(0);
  for (const args of [["register"], ["show"]]) {
    const refused = await run(other, args);
    expect(refused).toMatchObject({ code: 4, output: { reason: "controller_mismatch" } });
    expect(refused.stderr).toContain(cwd);
  }
  await git(cwd, "remote", "set-url", "arbitrary", "https://github.com/example/renamed.git");
  for (const args of [["register"], ["show"]])
    expect((await run(cwd, args)).output).toMatchObject({ reason: "controller_identity_mismatch" });
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT repository, checkout FROM projects").all()).toEqual([
    { repository: "example/one", checkout: cwd },
  ]);
});

test("refuses legacy local state by presence without reading or changing its contents", async () => {
  const cwd = await repository();
  await Bun.write(`${cwd}/.operator/unfinished`, "old work\n", { createPath: true });
  for (const args of [["register"], ["show"]]) {
    const refused = await run(cwd, args);
    expect(refused).toMatchObject({
      code: 3,
      output: { reason: args[0] === "register" ? "legacy_project_state" : "state_missing" },
    });
    if (args[0] === "register") expect(refused.stderr).toContain("old release");
  }
  expect(await Bun.file(`${cwd}/.operator/unfinished`).text()).toBe("old work\n");
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
});

test("refuses bare repositories and linked controlling checkouts", async () => {
  const cwd = await repository();
  await git(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  await git(cwd, "worktree", "add", "-q", "--detach", `${root}/linked`);
  expect(await run(`${root}/linked`)).toMatchObject({
    code: 3,
    output: { reason: "linked_checkout" },
  });
  await git(root, "init", "--bare", "-q", `${root}/bare`);
  expect(await run(`${root}/bare`)).toMatchObject({
    code: 3,
    output: { reason: "bare_repository" },
  });
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
});

test("concurrent first registrations publish one complete database and isolate projects", async () => {
  const one = await repository();
  const two = await repository("other", "ssh://git@github.com/Example/Two.git");
  const results = await Promise.all([run(one), run(two), run(one), run(two)]);
  expect(results.map((result) => [result.code, result.stderr])).toEqual([
    [0, ""],
    [0, ""],
    [0, ""],
    [0, ""],
  ]);
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT repository, checkout FROM projects ORDER BY repository").all()).toEqual([
    { repository: "example/one", checkout: one },
    { repository: "example/two", checkout: two },
  ]);
  expect(db.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
  expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(11);
  expect((await run(one, ["show"])).output).toMatchObject({ data: { repository: "example/one" } });
  expect((await run(two, ["show"])).output).toMatchObject({ data: { repository: "example/two" } });
});

test("a held writer times out with no partial registration, then succeeds after release", async () => {
  const one = await repository();
  const two = await repository("other", "https://github.com/example/two.git");
  expect((await run(one)).code).toBe(0);
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await run(two);
    expect(result).toMatchObject({ code: 1, output: { reason: "state_busy" } });
    expect(db.query("SELECT repository FROM projects").all()).toEqual([
      { repository: "example/one" },
    ]);
  } finally {
    db.exec("ROLLBACK");
  }
  expect((await run(two)).code).toBe(0);
}, 15000);

test.each(["missing-history", "conflicting", "newer", "corrupt", "empty"])(
  "refuses %s device state without repair or replacement",
  async (mode) => {
    const cwd = await repository();
    const database = `${root}/state/operator/operator.sqlite`;
    if (mode === "corrupt" || mode === "empty")
      await Bun.write(database, mode === "empty" ? "" : "damaged bytes\n", { createPath: true });
    else {
      expect((await run(cwd)).code).toBe(0);
      using db = new Database(database);
      if (mode === "missing-history") db.exec("DROP TABLE __drizzle_migrations");
      if (mode === "conflicting") db.exec("UPDATE __drizzle_migrations SET hash = 'unknown'");
      if (mode === "newer")
        db.exec(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)",
        );
    }
    const before = await Bun.file(database).arrayBuffer();
    for (const args of [["register"], ["show"]]) {
      const result = await run(cwd, args);
      expect(result.code, result.stderr).toBe(3);
      expect(result.output).toMatchObject({
        reason: mode === "corrupt" ? "state_corrupt" : "state_incompatible",
      });
      expect(await Bun.file(database).arrayBuffer()).toEqual(before);
    }
  },
);

test("a missing controller and an unrecorded repository cannot be adopted by lookup", async () => {
  const cwd = await repository();
  const alternate = await repository("alternate");
  expect((await run(cwd)).code).toBe(0);
  await rename(cwd, `${root}/moved`);
  const result = await run(alternate, ["show"]);
  expect(result).toMatchObject({ code: 4, output: { reason: "controller_mismatch" } });
  expect(result.stderr).toContain(cwd);
  const unrelated = await repository("unrelated", "https://github.com/example/other.git");
  expect(await run(unrelated, ["show"])).toMatchObject({
    code: 3,
    output: { reason: "project_not_registered" },
  });
  using db = new Database(`${root}/state/operator/operator.sqlite`, { readonly: true });
  expect(db.query("SELECT checkout FROM projects").all()).toEqual([{ checkout: cwd }]);
});

test("external Git commands run with no device database writer lock", async () => {
  const cwd = await repository();
  expect((await run(cwd)).code).toBe(0);
  const executable = Bun.which("git");
  expect(executable).not.toBeNull();
  await Bun.write(
    `${root}/tools/git`,
    `#!${process.execPath}\nimport { Database } from "bun:sqlite";\nusing db = new Database(${JSON.stringify(`${root}/state/operator/operator.sqlite`)}, { readwrite: true });\ndb.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE; ROLLBACK");\nconst child = Bun.spawnSync([${JSON.stringify(executable)}, ...Bun.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });\nprocess.exit(child.exitCode);\n`,
    { createPath: true },
  );
  await chmod(`${root}/tools/git`, 0o755);
  for (const command of ["register", "move", "list"])
    expect(await run(cwd, [command], { PATH: `${root}/tools` })).toMatchObject({ code: 0 });
});

test.each(
  [
    ["register", "--repository"],
    ["register", "--repository", "--json"],
    ["register", "--repository", "a/b", "--repository", "a/b"],
    ["register", "--unknown"],
    ["show", "--repository", "a/b"],
    ["register", "--json"],
    ["remove"],
    ["remove", "example/one", "--person-instructed", "--person-instructed"],
    ["remove", "example/one", "--repository", "example/one"],
    ["list", "--repository", "example/one"],
    ["move", "--person-instructed"],
  ].map((args) => ({ args })),
)(
  "refuses invalid project arguments %j without invoking tools or creating state",
  async ({ args }) => {
    const databaseBefore = await registerTestDevice(root);
    const result = await run(root, args, { PATH: `${root}/no-tools` });
    expect(result).toMatchObject({ code: 2, output: { reason: "invalid_arguments" } });
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
      "state/operator/operator.sqlite",
    ]);
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
      databaseBefore,
    );
  },
);
