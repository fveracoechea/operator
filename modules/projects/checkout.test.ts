import { afterAll, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { inspectCheckout } from "./checkout.ts";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-checkout-")));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("inspects real Git metadata and deduplicates remote identities", async () => {
  await mkdir(`${root}/repo/nested`, { recursive: true });
  for (const args of [
    ["init", "-q", `${root}/repo`],
    ["-C", `${root}/repo`, "remote", "add", "first", "git@github.com:Owner/Repo.git"],
    ["-C", `${root}/repo`, "remote", "add", "second", "https://github.com/owner/repo.git"],
  ]) {
    const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  }
  expect(await inspectCheckout(`${root}/repo/nested`)).toEqual({
    checkout: `${root}/repo`,
    repositories: ["owner/repo"],
  });
  await symlink(`${root}/absent`, `${root}/repo/.operator`);
  expect(await inspectCheckout(`${root}/repo`)).toMatchObject({ reason: "legacy_project_state" });
});

test("keeps unavailable, interrupted, and failed Git observations as refusals", async () => {
  const spy = spyOn(ToolInvocation, "run");
  try {
    spy.mockResolvedValue({ status: "unavailable", tool: "git", detail: "not installed" });
    expect(await inspectCheckout(root)).toEqual({
      reason: "git_unavailable",
      detail: "not installed",
    });
    spy.mockResolvedValue({ status: "no-answer", detail: "interrupted" });
    expect(await inspectCheckout(root)).toMatchObject({ reason: "git_unavailable" });
    spy.mockResolvedValue({
      status: "completed",
      exitCode: 128,
      stdout: "",
      stderr: "not a repository",
    });
    expect(await inspectCheckout(root)).toMatchObject({
      reason: "git_checkout_invalid",
      detail: "not a repository",
    });
  } finally {
    spy.mockRestore();
  }
});
