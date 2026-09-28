import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { ReleaseInstall } from "./main.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts a base commit whose JSR manifest and lock pin the same release", async () => {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-jsr-base-${crypto.randomUUID()}`;
  roots.push(root);
  const dependencies = { "@fveracoechea/operator": "npm:@jsr/fveracoechea__operator@0.4.0" };
  await Bun.write(
    `${root}/package.json`,
    JSON.stringify({
      scripts: { operator: "bun node_modules/@fveracoechea/operator/cli.js" },
      devDependencies: dependencies,
    }),
    { createPath: true },
  );
  const lockBytes = new TextEncoder().encode(
    JSON.stringify({
      workspaces: { "": { devDependencies: dependencies } },
      packages: { "@fveracoechea/operator": ["@jsr/fveracoechea__operator@0.4.0"] },
    }),
  );
  await Bun.write(`${root}/bun.lock`, lockBytes);

  expect(
    await ReleaseInstall.worktree({
      worktreeRoot: root,
      version: "0.4.0",
      lockName: "bun.lock",
      lockBytes,
    }),
  ).toBeNull();
  await Bun.write(
    `${root}/package.json`,
    JSON.stringify({ scripts: { operator: "bun other.js" }, devDependencies: dependencies }),
  );
  expect(
    await ReleaseInstall.worktree({
      worktreeRoot: root,
      version: "0.4.0",
      lockName: "bun.lock",
      lockBytes,
    }),
  ).toContain("package.json");
});
