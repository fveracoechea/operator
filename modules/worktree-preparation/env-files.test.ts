import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { approvedEnvFile, copyEnvFiles } from "./env-files.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-env-files-"));
  await mkdir(`${root}/controller`);
  await mkdir(`${root}/worktree`);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("only local environment overrides inside the checkout qualify", () => {
  for (const file of [".env.local", ".env.test.local", "apps/web/.env.development.local"])
    expect(approvedEnvFile(file)).toBe(true);
  for (const file of [
    ".env",
    ".env.production",
    ".env.local.backup",
    "env.local",
    "../.env.local",
    "/abs/.env.local",
    "a/./.env.local",
    "a//.env.local",
    "a\\.env.local",
    "",
  ])
    expect(approvedEnvFile(file)).toBe(false);
});

test("copies nested files, preserves destinations, and refuses links on either side", async () => {
  const controller = `${root}/controller`;
  const worktree = `${root}/worktree`;
  await Bun.write(`${controller}/.env.local`, "A=1\n");
  await Bun.write(`${controller}/apps/web/.env.test.local`, "B=1\n", { createPath: true });
  await Bun.write(`${controller}/kept/.env.local`, "C=controller\n", { createPath: true });
  await Bun.write(`${worktree}/kept/.env.local`, "C=worktree\n", { createPath: true });
  await Bun.write(`${root}/secret`, "SECRET=1\n");
  await symlink(`${root}/secret`, `${controller}/.env.link.local`);
  await Bun.write(`${controller}/linked-dir-target/.env.local`, "D=1\n", { createPath: true });
  await symlink(`${controller}/linked-dir-target`, `${controller}/linked`);
  await Bun.write(`${controller}/escape/.env.local`, "E=1\n", { createPath: true });
  await symlink(root, `${worktree}/escape`);
  const result = await copyEnvFiles({
    controller,
    worktree,
    files: [
      ".env.local",
      "apps/web/.env.test.local",
      "kept/.env.local",
      ".env.link.local",
      "linked/.env.local",
      "escape/.env.local",
      "../secret",
      ".env",
    ],
  });
  expect(result).toEqual({
    copied: [".env.local", "apps/web/.env.test.local"],
    preserved: ["kept/.env.local"],
    refused: ["../secret", ".env", ".env.link.local", "escape/.env.local", "linked/.env.local"],
  });
  expect(await Bun.file(`${worktree}/apps/web/.env.test.local`).text()).toBe("B=1\n");
  expect(await Bun.file(`${worktree}/kept/.env.local`).text()).toBe("C=worktree\n");
  expect(await Bun.file(`${root}/.env.local`).exists()).toBe(false);
  expect(await Bun.file(`${worktree}/.env.link.local`).exists()).toBe(false);
});
