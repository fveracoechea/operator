import { afterAll, expect, test } from "bun:test";
// Bun has no directory metadata, temporary-directory, or recursive removal API.
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import {
  acquireMutationClaim,
  recoverMutationClaim,
  mutationStateDirectory,
} from "./mutation-claim.ts";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Environment } from "../src/modules/environment/main.ts";

const root = await mkdtemp("/tmp/opencode/mutation-claim-");
afterAll(async () => rm(root, { recursive: true, force: true }));

test("one worktree excludes competitors, but a different worktree remains independent", async () => {
  const state = await mutationStateDirectory(root);
  expect(state).toStartWith(`${tmpdir()}/operator-mutation/`);
  const claim = await acquireMutationClaim(state);
  expect(claim).not.toHaveProperty("error");
  expect(await acquireMutationClaim(state)).toHaveProperty(
    "error",
    "Mutation worktree busy. Use --recover-claim only after its owner stops.",
  );
  expect(await recoverMutationClaim(state)).toHaveProperty("error");
  await mkdir(`${root}/other`);
  const other = await acquireMutationClaim(await mutationStateDirectory(`${root}/other`));
  expect(other).not.toHaveProperty("error");
  if (!("error" in claim)) await claim.release();
  if (!("error" in other)) await other.release();
  const next = await acquireMutationClaim(state);
  expect(next).not.toHaveProperty("error");
  if (!("error" in next)) await next.release();
});

test("recovery archives a dead owner's claim and preserves historical evidence", async () => {
  const cwd = `${root}/dead`;
  await mkdir(cwd);
  const state = await mutationStateDirectory(cwd);
  const claim = await acquireMutationClaim(state);
  expect(claim).not.toHaveProperty("error");
  if ("error" in claim) return;
  const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
  expect(await dead.exited).toBe(0);
  await Bun.write(
    `${state}/claim/owner.json`,
    JSON.stringify({ version: 1, token: claim.token, pid: dead.pid }),
  );
  await Bun.write(`${state}/completed.json`, '{"status":"completed"}');
  expect(await recoverMutationClaim(state)).toEqual({ recovered: true });
  expect(await Bun.file(`${state}/recovered-${claim.token}/owner.json`).exists()).toBe(true);
  expect(await Bun.file(`${state}/completed.json`).text()).toBe('{"status":"completed"}');
  const next = await acquireMutationClaim(state);
  expect(next).not.toHaveProperty("error");
  if (!("error" in next)) await next.release();
});

test("uncertain owners and live orphan groups cannot be recovered or overwritten", async () => {
  const cwd = `${root}/uncertain`;
  await mkdir(cwd);
  const state = await mutationStateDirectory(cwd);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) return expect.unreachable("claim admission failed");
  await Bun.write(`${state}/claim/owner.json`, "truncated");
  expect(await recoverMutationClaim(state)).toHaveProperty("error");
  expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe("truncated");
  const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
  await dead.exited;
  const live = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    detached: true,
  });
  try {
    const record = JSON.stringify({
      version: 1,
      token: claim.token,
      pid: dead.pid,
      group: live.pid,
    });
    await Bun.write(`${state}/claim/owner.json`, record);
    expect(await recoverMutationClaim(state)).toHaveProperty("error");
    expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe(record);
    expect(live.exitCode).toBe(null);
    expect(process.kill(live.pid, 0)).toBe(true);
  } finally {
    live.kill();
    await live.exited;
  }
  expect(await recoverMutationClaim(state)).toEqual({ recovered: true });
});

test("a Git worktree has one canonical claim even when invoked from a subdirectory or a path link", async () => {
  const cwd = `${root}/canonical`;
  await mkdir(`${cwd}/nested`, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  const state = await mutationStateDirectory(cwd);
  expect(await mutationStateDirectory(`${cwd}/nested`)).toBe(state);
  expect(state).toBe(`${cwd}/.git/mutation-campaign`);
  await symlink(cwd, `${root}/canonical-link`);
  expect(await mutationStateDirectory(`${root}/canonical-link`)).toBe(state);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) return expect.unreachable("claim admission failed");
  const temporary = `${root}/different-tmpdir`;
  await mkdir(temporary);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { mutationStateDirectory, acquireMutationClaim } from ${JSON.stringify(`${import.meta.dir}/mutation-claim.ts`)};
    const state = await mutationStateDirectory(process.cwd());
    const claim = await acquireMutationClaim(state);
    console.log(JSON.stringify({ state, busy: "error" in claim }));
  `,
    ],
    { cwd, env: Environment.child({ TMPDIR: temporary }), stdout: "pipe", stderr: "pipe" },
  );
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  expect(z.object({ state: z.string(), busy: z.boolean() }).parse(JSON.parse(output))).toEqual({
    state,
    busy: true,
  });
  await claim.release();
});

test("non-Git fixtures create a private namespace inside a fresh temporary directory", async () => {
  const cwd = `${root}/plain-temporary`;
  const temporary = `${root}/fresh-temporary`;
  await mkdir(cwd);
  await mkdir(temporary);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { mutationStateDirectory } from ${JSON.stringify(`${import.meta.dir}/mutation-claim.ts`)};
    console.log(await mutationStateDirectory(process.cwd()));
  `,
    ],
    { cwd, env: Environment.child({ TMPDIR: temporary }), stdout: "pipe", stderr: "pipe" },
  );
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  const state = output.trim();
  expect(state).toStartWith(`${temporary}/operator-mutation/`);
  expect((await lstat(state)).mode % 512).toBe(0o700);
});

test("only the recorded token can release a claim, and process-group ownership is persisted", async () => {
  const cwd = `${root}/token`;
  await mkdir(cwd);
  const state = await mutationStateDirectory(cwd);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) return expect.unreachable("claim admission failed");
  await claim.setGroup(123);
  expect(
    z.object({ group: z.number() }).parse(await Bun.file(`${state}/claim/owner.json`).json()),
  ).toEqual({ group: 123 });
  await Bun.write(
    `${state}/claim/owner.json`,
    JSON.stringify({ version: 1, token: crypto.randomUUID(), pid: process.pid }),
  );
  const replacement = await Bun.file(`${state}/claim/owner.json`).text();
  await claim.release();
  expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe(replacement);
  await Bun.write(`${state}/claim/owner.json`, "uncertain");
  await claim.release();
  expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe("uncertain");
});

test("recovery refuses invalid process identities and concurrent recovery without changing the claim", async () => {
  const cwd = `${root}/invalid-process`;
  await mkdir(cwd);
  const state = await mutationStateDirectory(cwd);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) return expect.unreachable("claim admission failed");
  const invalid = JSON.stringify({ version: 1, token: claim.token, pid: Number.MAX_SAFE_INTEGER });
  await Bun.write(`${state}/claim/owner.json`, invalid);
  expect(await recoverMutationClaim(state)).toEqual({
    error: "Mutation claim is active or uncertain; recovery refused without changing it.",
  });
  expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe(invalid);
  await mkdir(`${state}/recovery`);
  expect(await recoverMutationClaim(state)).toHaveProperty("error");
  expect(await Bun.file(`${state}/claim/owner.json`).text()).toBe(invalid);
  await rm(`${state}/recovery`, { recursive: true });
});

test("a surviving descendant prevents recovery after its group leader and claim owner exit", async () => {
  const cwd = `${root}/orphan`;
  await mkdir(cwd);
  const state = await mutationStateDirectory(cwd);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) return expect.unreachable("claim admission failed");
  const group = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    console.log(child.pid);
    child.unref();
    process.exit(0);
  `,
    ],
    { detached: true, stdout: "pipe", stderr: "pipe" },
  );
  const descendant = Number(await new Response(group.stdout).text());
  expect(await group.exited).toBe(0);
  expect(descendant).toBeGreaterThan(0);
  try {
    await claim.setGroup(group.pid);
    await claim.release();
    expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(true);
    await Bun.write(
      `${state}/claim/owner.json`,
      JSON.stringify({ version: 1, token: claim.token, pid: group.pid, group: group.pid }),
    );
    expect(await recoverMutationClaim(state)).toHaveProperty("error");
    expect(process.kill(descendant, 0)).toBe(true);
  } finally {
    process.kill(descendant, "SIGKILL");
  }
});

test("release preserves the claim while its recorded group can still have live work", async () => {
  const cwd = `${root}/live-release`;
  await mkdir(cwd);
  const state = await mutationStateDirectory(cwd);
  const claim = await acquireMutationClaim(state);
  if ("error" in claim) return expect.unreachable("claim admission failed");
  const group = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    detached: true,
  });
  await claim.setGroup(group.pid);
  try {
    await claim.release();
    expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(true);
    expect(group.exitCode).toBe(null);
  } finally {
    group.kill();
    await group.exited;
  }
  await claim.release();
  expect(await Bun.file(`${state}/claim/owner.json`).exists()).toBe(false);
});
