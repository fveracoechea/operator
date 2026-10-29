import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
// Bun has no temporary-directory, symlink, mode, directory listing, or recursive removal API.
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { migrationsFolder } from "./database.ts";
import { ensureProjectDirectory, finishProjectRemoval } from "./project-files.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("directory creation rechecks registration and cleanup preserves an independent durable obligation", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const project = {
    repository: "owner/repo",
    checkout: "/isolated/controller",
    registeredAt: "now",
  };
  expect(ensureProjectDirectory(db, paths, project)).toMatchObject({
    tag: "Err",
    error: { reason: "controller_mismatch" },
  });
  expect(await Bun.file(`${paths.projects}/owner/repo/report`).exists()).toBe(false);
  db.query("INSERT INTO projects VALUES (?, ?, ?)").run(
    project.repository,
    project.checkout,
    project.registeredAt,
  );
  expect(ensureProjectDirectory(db, paths, project).tag).toBe("Ok");
  await Bun.write(`${paths.projects}/owner/repo/report`, "old report");
  await Bun.write(`${root}/outside/keep`, "not project content", { createPath: true });
  await symlink(`${root}/outside`, `${paths.projects}/owner/repo/link`);
  db.exec("DELETE FROM projects; INSERT INTO project_removals VALUES ('owner/repo', 'now')");
  expect(finishProjectRemoval(db, paths, project.repository).tag).toBe("Ok");
  expect(db.query("SELECT * FROM project_removals").all()).toEqual([]);
  expect(await Bun.file(`${paths.projects}/owner/repo/report`).exists()).toBe(false);
  expect(await Bun.file(`${root}/outside/keep`).text()).toBe("not project content");
  // A stale cleaner must not touch state created after its obligation ended.
  await Bun.write(`${paths.projects}/owner/repo/new`, "new generation", { createPath: true });
  expect(finishProjectRemoval(db, paths, project.repository).tag).toBe("Ok");
  expect(await Bun.file(`${paths.projects}/owner/repo/new`).text()).toBe("new generation");
});

test("cleanup refuses linked ancestors and non-directory paths without clearing the pending record", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  db.exec("INSERT INTO project_removals VALUES ('owner/repo', 'now')");
  await Bun.write(`${root}/outside/repo/keep`, "keep", { createPath: true });
  await Bun.write(`${paths.projects}/placeholder`, "parent", { createPath: true });
  await symlink(`${root}/outside`, `${paths.projects}/owner`);
  expect(finishProjectRemoval(db, paths, "owner/repo")).toMatchObject({
    tag: "Err",
    error: { reason: "project_cleanup_pending" },
  });
  expect(await Bun.file(`${root}/outside/repo/keep`).text()).toBe("keep");
  await rm(`${paths.projects}/owner`);
  await Bun.write(`${paths.projects}/owner`, "not a directory");
  expect(finishProjectRemoval(db, paths, "owner/repo")).toMatchObject({
    tag: "Err",
    error: {
      reason: "project_cleanup_pending",
      detail: `The state path is not a real directory: ${paths.projects}/owner. Preserve external content and resolve this path before repeating the command.`,
    },
  });
  expect(db.query("SELECT * FROM project_removals").all()).toEqual([
    { repository: "owner/repo", removed_at: "now" },
  ]);
  expect(await Bun.file(`${paths.projects}/owner`).text()).toBe("not a directory");
  await rm(`${paths.projects}/owner`);
  expect(finishProjectRemoval(db, paths, "owner/repo").tag).toBe("Ok");
});

test("directory creation makes a private directory and refuses a linked state root", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  const project = {
    repository: "owner/repo",
    checkout: "/isolated/controller",
    registeredAt: "now",
  };
  db.query("INSERT INTO projects VALUES (?, ?, ?)").run(project.repository, "/elsewhere", "now");
  expect(ensureProjectDirectory(db, paths, project)).toMatchObject({
    tag: "Err",
    error: {
      reason: "controller_mismatch",
      detail: "The registration changed before its state directory could be created.",
    },
  });
  db.query("UPDATE projects SET checkout = ?").run(project.checkout);
  expect(ensureProjectDirectory(db, paths, project)).toMatchObject({ tag: "Ok", value: undefined });
  const directory = OperatorHome.projectDirectory(paths, project.repository);
  expect((await stat(directory)).mode.toString(8)).toEndWith("700");
  await rm(paths.stateRoot, { recursive: true });
  await mkdir(`${root}/outside`, { recursive: true });
  await mkdir(path.dirname(paths.stateRoot), { recursive: true });
  await symlink(`${root}/outside`, paths.stateRoot);
  expect(ensureProjectDirectory(db, paths, project)).toMatchObject({
    tag: "Err",
    error: {
      reason: "project_cleanup_pending",
      detail: `The state path is not a real directory: ${paths.stateRoot}. Preserve external content and resolve this path before repeating the command.`,
    },
  });
  expect(await readdir(`${root}/outside`)).toEqual([]);
});

test("cleanup of a directory whose parents are gone succeeds and clears its record", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  db.exec("INSERT INTO project_removals VALUES ('owner/repo', 'now')");
  expect(finishProjectRemoval(db, paths, "owner/repo")).toMatchObject({
    tag: "Ok",
    value: undefined,
  });
  expect(db.query("SELECT * FROM project_removals").all()).toEqual([]);
  expect(await Bun.file(paths.stateRoot).exists()).toBe(false);
});

test.skipIf(asRoot)(
  "cleanup that the filesystem refuses keeps its record as an input failure",
  async () => {
    root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
    const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
    using db = new Database(":memory:");
    migrate(drizzle(db), { migrationsFolder });
    db.exec("INSERT INTO project_removals VALUES ('owner/repo', 'now')");
    const directory = OperatorHome.projectDirectory(paths, "owner/repo");
    await Bun.write(`${directory}/inner/report`, "kept", { createPath: true });
    await chmod(`${directory}/inner`, 0o500);
    try {
      expect(finishProjectRemoval(db, paths, "owner/repo")).toMatchObject({
        tag: "Err",
        error: { reason: "state_io_failed" },
      });
    } finally {
      await chmod(`${directory}/inner`, 0o700);
    }
    expect(db.query("SELECT repository FROM project_removals").all()).toEqual([
      { repository: "owner/repo" },
    ]);
    expect(await Bun.file(`${directory}/inner/report`).text()).toBe("kept");
  },
);

test.skipIf(asRoot)(
  "an unreadable ancestor or an unwritable parent is an input failure that changes nothing",
  async () => {
    root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
    const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
    using db = new Database(":memory:");
    migrate(drizzle(db), { migrationsFolder });
    const project = {
      repository: "owner/repo",
      checkout: "/isolated/controller",
      registeredAt: "now",
    };
    db.query("INSERT INTO projects VALUES (?, ?, ?)").run(
      project.repository,
      project.checkout,
      "now",
    );
    db.exec("INSERT INTO project_removals VALUES ('owner/gone', 'now')");
    await mkdir(`${paths.projects}/owner/gone`, { recursive: true });
    await chmod(paths.projects, 0o600);
    try {
      // The check stops at the first unreadable segment, not at the removal itself.
      const refused = finishProjectRemoval(db, paths, "owner/gone");
      expect(refused).toMatchObject({ tag: "Err", error: { reason: "state_io_failed" } });
      if (refused.tag === "Err")
        expect(refused.error.detail).toContain(`'${paths.projects}/owner'`);
      expect(ensureProjectDirectory(db, paths, project)).toMatchObject({
        tag: "Err",
        error: { reason: "state_io_failed" },
      });
      await chmod(paths.projects, 0o700);
      await chmod(`${paths.projects}/owner`, 0o500);
      expect(ensureProjectDirectory(db, paths, project)).toMatchObject({
        tag: "Err",
        error: { reason: "state_io_failed" },
      });
    } finally {
      await chmod(paths.projects, 0o700);
      await chmod(`${paths.projects}/owner`, 0o700);
    }
    expect(await readdir(`${paths.projects}/owner`)).toEqual(["gone"]);
    expect(db.query("SELECT repository FROM project_removals").all()).toEqual([
      { repository: "owner/gone" },
    ]);
  },
);

test("directory work waits for the writer reservation before it touches files", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  await mkdir(paths.stateRoot, { recursive: true });
  using db = new Database(`${root}/state.sqlite`);
  migrate(drizzle(db), { migrationsFolder });
  const project = {
    repository: "owner/repo",
    checkout: "/isolated/controller",
    registeredAt: "now",
  };
  db.query("INSERT INTO projects VALUES (?, ?, ?)").run(
    project.repository,
    project.checkout,
    "now",
  );
  db.exec("INSERT INTO project_removals VALUES ('owner/gone', 'now')");
  await Bun.write(`${paths.projects}/owner/gone/report`, "kept");
  using competitor = new Database(`${root}/state.sqlite`);
  competitor.exec("BEGIN IMMEDIATE");
  const busy = { tag: "Err", error: { reason: "state_busy" } };
  expect(ensureProjectDirectory(db, paths, project)).toMatchObject(busy);
  expect(finishProjectRemoval(db, paths, "owner/gone")).toMatchObject(busy);
  competitor.exec("ROLLBACK");
  expect(await readdir(`${paths.projects}/owner`)).toEqual(["gone"]);
  expect(await Bun.file(`${paths.projects}/owner/gone/report`).text()).toBe("kept");
});

test.skipIf(asRoot)("a parent that cannot be synchronized keeps the pending record", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-project-files-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  using db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  db.exec("INSERT INTO project_removals VALUES ('owner/gone', 'now')");
  await mkdir(`${paths.projects}/owner/gone`, { recursive: true });
  // The parent allows the removal but not the read that synchronizes it.
  await chmod(`${paths.projects}/owner`, 0o300);
  try {
    expect(finishProjectRemoval(db, paths, "owner/gone")).toMatchObject({
      tag: "Err",
      error: { reason: "state_io_failed" },
    });
  } finally {
    await chmod(`${paths.projects}/owner`, 0o700);
  }
  expect(db.query("SELECT repository FROM project_removals").all()).toEqual([
    { repository: "owner/gone" },
  ]);
});
