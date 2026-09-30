import { afterEach, expect, test } from "bun:test";
// Bun has no chmod, temporary directory, realpath, recursive removal, OS temp path, or join API.
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function checkout(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "operator-worktree-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return root;
}

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function created(path: string, env: Record<string, string> = {}) {
  return run([process.execPath, join(import.meta.dir, "worktree.ts")], import.meta.dir, {
    ...env,
    HERDR_PLUGIN_EVENT: "worktree.created",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "worktree_created",
      data: { type: "worktree_created", worktree: { path, branch: "feature" } },
    }),
  });
}

/** Puts a package manager stand-in first on PATH that records where and how it ran. */
async function fakeTool(name: string, exitCode = 0) {
  const bin = await checkout({});
  const record = join(bin, "calls");
  await Bun.write(
    join(bin, name),
    `#!/bin/sh\nprintf '%s %s\\n' "$(pwd -P)" "$*" >> ${JSON.stringify(record)}\nexit ${exitCode}\n`,
  );
  await chmod(join(bin, name), 0o755);
  return {
    env: { PATH: `${bin}:${process.env.PATH}` },
    calls: async () => ((await Bun.file(record).exists()) ? Bun.file(record).text() : ""),
  };
}

/** A committed bun project whose dependency ships a bin, checked out with no node_modules. */
async function bunCheckout() {
  const root = await checkout({
    "package.json": JSON.stringify({ name: "consumer", dependencies: { tool: "file:./tool" } }),
    "tool/package.json": JSON.stringify({
      name: "tool",
      version: "1.0.0",
      bin: { tool: "bin.ts" },
    }),
    "tool/bin.ts": '#!/usr/bin/env bun\nconsole.log("tool ran");\n',
    "other/package.json": JSON.stringify({ name: "other", version: "1.0.0" }),
  });
  expect((await run([process.execPath, "install"], root)).exitCode).toBe(0);
  await rm(join(root, "node_modules"), { recursive: true });
  return { root, lockfile: await Bun.file(join(root, "bun.lock")).text() };
}

test("a new bun checkout can run a dependency's script after the hook", async () => {
  const { root, lockfile } = await bunCheckout();
  const before = await run([process.execPath, "run", "tool"], root);
  expect(before.stderr).toContain('Script not found "tool"');

  const hook = await created(root);

  expect(hook.exitCode).toBe(0);
  expect(hook.stdout).toContain(`Installed dependencies in ${root}.`);
  expect((await run([process.execPath, "run", "tool"], root)).stdout).toContain("tool ran");
  expect(await Bun.file(join(root, "bun.lock")).text()).toBe(lockfile);
});

test("a lockfile that disagrees with the manifest fails the hook and stays unchanged", async () => {
  const { root, lockfile } = await bunCheckout();
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({
      name: "consumer",
      dependencies: { tool: "file:./tool", other: "file:./other" },
    }),
  );

  const hook = await created(root);

  expect(hook.exitCode).not.toBe(0);
  expect(hook.stderr).toContain(
    `bun install --frozen-lockfile exited ${hook.exitCode} in ${root}.`,
  );
  expect(await Bun.file(join(root, "bun.lock")).text()).toBe(lockfile);
});

test.each([
  [["bun.lock"], "bun install --frozen-lockfile"],
  [["bun.lockb"], "bun install --frozen-lockfile"],
  [["package-lock.json"], "npm ci"],
  [["npm-shrinkwrap.json"], "npm ci"],
  [["package-lock.json", "bun.lock"], "bun install --frozen-lockfile"],
])("a checkout with %p installs with %s", async (lockfiles, command) => {
  const root = await checkout(
    Object.fromEntries([["package.json", "{}"], ...lockfiles.map((name) => [name, "{}"])]),
  );
  const npm = await fakeTool("npm");

  const hook = await created(root, npm.env);

  expect(hook.stdout).toContain(`Running \`${command}\` in ${root}.`);
  expect(await npm.calls()).toBe(command === "npm ci" ? `${await realpath(root)} ci\n` : "");
});

test("a failed install fails the hook, so the plugin log shows it", async () => {
  const root = await checkout({ "package.json": "{}", "package-lock.json": "{}" });
  const npm = await fakeTool("npm", 3);

  const hook = await created(root, npm.env);

  expect(hook.exitCode).toBe(3);
  expect(hook.stderr).toContain(`npm ci exited 3 in ${root}.`);
});

test("a package manager missing from PATH fails the hook with a clear message", async () => {
  const root = await checkout({ "package.json": "{}", "package-lock.json": "{}" });
  const empty = await checkout({});

  const hook = await created(root, { PATH: empty });

  expect(hook.exitCode).toBe(1);
  expect(hook.stderr).toContain(`Could not run npm ci in ${root}:`);
});

test("a checkout with no lockfile is left untouched", async () => {
  const root = await checkout({ "package.json": "{}" });
  const npm = await fakeTool("npm");

  const hook = await created(root, npm.env);

  expect(hook.exitCode).toBe(0);
  expect(hook.stdout).toContain(`No lockfile in ${root}. Skipped the dependency install.`);
  expect(await npm.calls()).toBe("");
});
