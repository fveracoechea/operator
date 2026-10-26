import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { migrationsFolder } from "./database.ts";
import { ensureProjectDirectory, finishProjectRemoval } from "./project-files.ts";

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
  expect(finishProjectRemoval(db, paths, "owner/repo").tag).toBe("Err");
  expect(db.query("SELECT * FROM project_removals").all()).toEqual([
    { repository: "owner/repo", removed_at: "now" },
  ]);
  expect(await Bun.file(`${paths.projects}/owner`).text()).toBe("not a directory");
  await rm(`${paths.projects}/owner`);
  expect(finishProjectRemoval(db, paths, "owner/repo").tag).toBe("Ok");
});
