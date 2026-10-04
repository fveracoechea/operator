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

const script = "bun node_modules/@fveracoechea/operator/cli.js";
const pinned = { "@fveracoechea/operator": "npm:@jsr/fveracoechea__operator@0.4.0" };
const pinnedLock = {
  workspaces: { "": { devDependencies: pinned } },
  packages: { "@fveracoechea/operator": ["@jsr/fveracoechea__operator@0.4.0"] },
};

async function worktree(request: {
  manifest: unknown;
  lock?: string;
  lockName?: string;
  selectedLock?: string;
}) {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-jsr-base-${crypto.randomUUID()}`;
  roots.push(root);
  await Bun.write(`${root}/package.json`, JSON.stringify(request.manifest), { createPath: true });
  if (request.lock !== undefined) await Bun.write(`${root}/bun.lock`, request.lock);
  const selected = request.selectedLock ?? request.lock ?? "";
  return ReleaseInstall.worktree({
    worktreeRoot: root,
    version: "0.4.0",
    lockName: request.lockName ?? "bun.lock",
    lockBytes: new TextEncoder().encode(selected),
  });
}

const declared = { scripts: { operator: script }, devDependencies: pinned };
const manifestRefusal =
  "The worktree base commit needs package.json with @fveracoechea/operator at npm:@jsr/fveracoechea__operator@0.4.0 as a devDependency and scripts.operator set to bun node_modules/@fveracoechea/operator/cli.js. Commit the installation and dispatch from that commit.";
const unreadableLock =
  "The worktree bun.lock cannot be read. Regenerate it with Bun, commit it, and dispatch from that commit.";

test.each([
  ["no devDependencies", { scripts: { operator: script } }, manifestRefusal],
  [
    "a different script",
    { scripts: { operator: "bun other.js" }, devDependencies: pinned },
    manifestRefusal,
  ],
  ["a dependency group that is not a record", { ...declared, dependencies: 1 }, manifestRefusal],
  // The worktree check reads only the operator script, so another script that is not text passes.
  ["a script that is not text", { ...declared, scripts: { operator: script, other: 1 } }, null],
])("checks a worktree manifest with %s", async (_name, manifest, refusal) => {
  expect(await worktree({ manifest, lock: JSON.stringify(pinnedLock) })).toBe(refusal);
});

test.each([
  [
    "a binary lock",
    { lock: JSON.stringify(pinnedLock), lockName: "bun.lockb" },
    "The JSR worktree needs a committed bun.lock from Bun 1.4 or later. Commit the installation and dispatch from that commit.",
  ],
  [
    "no lock",
    {},
    "The worktree base commit has no bun.lock. Commit the installation and dispatch from that commit.",
  ],
  [
    "a lock that differs from the selected one",
    { lock: JSON.stringify(pinnedLock), selectedLock: "{}" },
    "The worktree bun.lock differs from the selected installation. Commit the matching manifest and lock, then dispatch from that commit.",
  ],
  ["a lock that is not JSONC", { lock: "{" }, unreadableLock],
  ["a lock with no root workspace", { lock: JSON.stringify({ packages: {} }) }, unreadableLock],
  [
    "a lock whose devDependencies differ from the manifest",
    {
      lock: JSON.stringify({
        ...pinnedLock,
        workspaces: { "": { devDependencies: {}, dependencies: {} } },
      }),
    },
    "The worktree package.json devDependencies differs from bun.lock. Commit a frozen installation at the base commit before dispatch.",
  ],
  [
    "a lock that pins another version",
    {
      lock: JSON.stringify({
        ...pinnedLock,
        packages: { "@fveracoechea/operator": ["@jsr/fveracoechea__operator@0.3.0"] },
      }),
    },
    "The worktree bun.lock does not pin @fveracoechea/operator at 0.4.0. Commit the selected JSR dependency before dispatch.",
  ],
])("refuses a worktree with %s", async (_name, lock, refusal) => {
  expect(await worktree({ manifest: declared, ...lock })).toBe(refusal);
});
