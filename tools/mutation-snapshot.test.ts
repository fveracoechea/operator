import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory, file-mode, or recursive removal API.
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { admitMutationSnapshot, mutationInputIdentity } from "./mutation-snapshot.ts";

const root = await mkdtemp("/tmp/opencode/mutation-snapshot-");
afterAll(async () => rm(root, { recursive: true, force: true }));

test("admission freezes actual tracked and untracked bytes and detects later source edits", async () => {
  const cwd = `${root}/project`;
  await Bun.write(`${cwd}/tracked.ts`, "original\n");
  await Bun.write(`${cwd}/.gitignore`, "ignored.txt\n");
  const git = Bun.spawnSync(["git", "init", "-q", cwd]);
  expect(git.exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "add", "."], { cwd }).exitCode).toBe(0);
  await Bun.write(`${cwd}/tracked.ts`, "admitted\n");
  await Bun.write(`${cwd}/fixture.txt`, "untracked\n");
  await Bun.write(`${cwd}/ignored.txt`, "not relevant\n");
  await Bun.write(`${cwd}/.operator/untouched`, "legacy\n");
  const snapshot = await admitMutationSnapshot(cwd, `${root}/snapshot`);
  expect(snapshot.identity).toBe(await mutationInputIdentity(cwd));
  expect(await Bun.file(`${snapshot.directory}/tracked.ts`).text()).toBe("admitted\n");
  expect(await Bun.file(`${snapshot.directory}/fixture.txt`).text()).toBe("untracked\n");
  expect(await Bun.file(`${snapshot.directory}/ignored.txt`).exists()).toBe(false);
  await expect(lstat(`${snapshot.directory}/node_modules`)).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  expect(await Bun.file(`${snapshot.directory}/.operator/untouched`).exists()).toBe(false);
  await Bun.write(`${cwd}/tracked.ts`, "later\n");
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  expect(await Bun.file(`${snapshot.directory}/tracked.ts`).text()).toBe("admitted\n");
});

test("identities include file names, binary bytes, executable modes, additions, and deletions", async () => {
  const cwd = `${root}/binary`;
  await Bun.write(`${cwd}/asset`, new Uint8Array([0, 255, 1]));
  const original = await mutationInputIdentity(cwd);
  await chmod(`${cwd}/asset`, 0o755);
  expect(await mutationInputIdentity(cwd)).not.toBe(original);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/binary-snapshot`);
  expect(await Bun.file(`${snapshot.directory}/asset`).bytes()).toEqual(
    new Uint8Array([0, 255, 1]),
  );
  const { mode } = await import("node:fs/promises").then((fs) =>
    fs.stat(`${snapshot.directory}/asset`),
  );
  expect(mode % 512).toBe(0o755);
  await Bun.write(`${cwd}/asset`, new Uint8Array([0, 255, 2]));
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  await Bun.write(`${cwd}/asset`, new Uint8Array([0, 255, 1]));
  await Bun.write(`${cwd}/new`, "new");
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  await rm(`${cwd}/new`);
  expect(await mutationInputIdentity(cwd)).toBe(snapshot.identity);
  await rm(`${cwd}/asset`);
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
});

test("source links are refused rather than retaining mutable external inputs", async () => {
  const cwd = `${root}/links`;
  await Bun.write(`${cwd}/regular`, "safe");
  await symlink(`${cwd}/regular`, `${cwd}/linked`);
  await expect(admitMutationSnapshot(cwd, `${root}/links-snapshot`)).rejects.toThrow(
    "Unsupported snapshot input: linked",
  );
});

test("non-Git snapshots include nested inputs but never inspect host state or mutation outputs", async () => {
  const cwd = `${root}/plain`;
  await Bun.write(`${cwd}/nested/fixture`, "nested");
  for (const name of [
    ".operator",
    ".claude",
    ".agents",
    ".git",
    ".mutation-active",
    "node_modules",
  ]) {
    await Bun.write(`${cwd}/${name}/private`, "excluded");
  }
  const identity = await mutationInputIdentity(cwd);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/newparent/nested/plain-snapshot`);
  expect(snapshot.identity).toBe(identity);
  expect(await Bun.file(`${snapshot.directory}/nested/fixture`).text()).toBe("nested");
  for (const name of [".operator", ".claude", ".agents", ".git", ".mutation-active"]) {
    expect(await Bun.file(`${snapshot.directory}/${name}/private`).exists()).toBe(false);
    await Bun.write(`${cwd}/${name}/private`, "changed excluded");
  }
  expect(await mutationInputIdentity(cwd)).toBe(identity);
  expect(
    await import("node:fs/promises").then((fs) =>
      fs.readlink(`${snapshot.directory}/node_modules`),
    ),
  ).toBe(`${cwd}/node_modules`);
});

test("staging unchanged inputs cannot change their admitted identity, and tracked deletions are absent", async () => {
  const cwd = `${root}/staging`;
  await Bun.write(`${cwd}/a`, "tracked");
  await Bun.write(`${cwd}/z`, "untracked");
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "add", "a"], { cwd }).exitCode).toBe(0);
  const identity = await mutationInputIdentity(cwd);
  expect(Bun.spawnSync(["git", "add", "z"], { cwd }).exitCode).toBe(0);
  expect(await mutationInputIdentity(cwd)).toBe(identity);
  await rm(`${cwd}/a`);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/deleted-snapshot`);
  expect(await Bun.file(`${snapshot.directory}/a`).exists()).toBe(false);
  expect(await Bun.file(`${snapshot.directory}/z`).text()).toBe("untracked");
});

test("concurrent source writes refuse admission rather than accepting a mixed copy", async () => {
  const cwd = `${root}/changing`;
  for (let index = 0; index < 30; index++)
    await Bun.write(`${cwd}/large-${index}`, new Uint8Array(1_000_000));
  const writer = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    let value = 0;
    while (true) {
      await Bun.write(${JSON.stringify(`${cwd}/0-marker`)}, String(value++));
      await Bun.sleep(1);
    }
  `,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    while (!(await Bun.file(`${cwd}/0-marker`).exists())) await Bun.sleep(5);
    await expect(admitMutationSnapshot(cwd, `${root}/changing-snapshot`)).rejects.toThrow(
      "Mutation inputs changed during snapshot admission.",
    );
  } finally {
    writer.kill();
    await writer.exited;
  }
});
