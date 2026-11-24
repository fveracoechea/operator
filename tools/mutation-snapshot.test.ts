import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory, file-mode, or recursive removal API.
import { chmod, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { admitMutationSnapshot, mutationInputIdentity } from "./mutation-snapshot.ts";

const root = await mkdtemp(`${tmpdir()}/mutation-snapshot-`);
afterAll(async () => rm(root, { recursive: true, force: true }));

async function storeFixture(name: string) {
  const cwd = `${root}/${name}`;
  const manifest = '{"main":"index.js","type":"module"}';
  for (const store of ["first", "second"]) {
    const installed = `${cwd}/node_modules/.bun/${store}/node_modules`;
    await Bun.write(`${installed}/application/package.json`, manifest);
    await Bun.write(`${installed}/application/index.js`, 'export {default} from "dep";');
    await Bun.write(`${installed}/dep/package.json`, manifest);
    await Bun.write(`${installed}/dep/index.js`, `export default "${store}";`);
  }
  await Bun.write(`${cwd}/node_modules/dep/package.json`, manifest);
  await Bun.write(`${cwd}/node_modules/dep/index.js`, 'export default "hoisted";');
  await symlink(".bun/first/node_modules/application", `${cwd}/node_modules/application`);
  return cwd;
}

function applicationValue(cwd: string) {
  const result = Bun.spawnSync(
    [process.execPath, "-e", 'import value from "application"; console.log(value);'],
    { cwd },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

test("store-backed directory aliases retain physical-parent dependency resolution", async () => {
  const cwd = await storeFixture("store-resolution");
  expect(applicationValue(cwd)).toBe("first");
  const snapshot = await admitMutationSnapshot(cwd, `${root}/store-resolution-snapshot`);
  expect(applicationValue(snapshot.directory)).toBe("first");
  expect((await lstat(`${snapshot.directory}/node_modules/application`)).isSymbolicLink()).toBe(
    true,
  );
  expect(await readlink(`${snapshot.directory}/node_modules/application`)).toBe(
    ".bun/first/node_modules/application",
  );
  expect(await realpath(`${snapshot.directory}/node_modules/application`)).toBe(
    `${snapshot.directory}/node_modules/.bun/first/node_modules/application`,
  );
});

test("retargeting a directory alias with identical package bytes invalidates current qualification", async () => {
  const cwd = await storeFixture("store-retarget");
  const snapshot = await admitMutationSnapshot(cwd, `${root}/store-retarget-snapshot`);
  const before = await mutationInputIdentity(cwd);
  await rm(`${cwd}/node_modules/application`);
  await symlink(".bun/second/node_modules/application", `${cwd}/node_modules/application`);
  expect(applicationValue(cwd)).toBe("second");
  expect(await mutationInputIdentity(cwd)).not.toBe(before);
  expect(applicationValue(snapshot.directory)).toBe("first");
});

test("installed application imports retain admitted bytes and modes and invalidate current qualification", async () => {
  const cwd = `${root}/installed`;
  await Bun.write(`${cwd}/package.json`, JSON.stringify({ dependencies: { application: "1" } }));
  await Bun.write(
    `${cwd}/node_modules/application/package.json`,
    '{"name":"application","main":"index.js"}',
  );
  await Bun.write(`${cwd}/node_modules/application/index.js`, 'export default "admitted";');
  await chmod(`${cwd}/node_modules/application/index.js`, 0o755);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/installed-snapshot`);
  function imported() {
    return Bun.spawnSync(
      [process.execPath, "-e", 'import value from "application"; console.log(value)'],
      {
        cwd: snapshot.directory,
      },
    );
  }

  expect(imported().stdout.toString().trim()).toBe("admitted");
  await Bun.write(`${cwd}/node_modules/application/index.js`, 'export default "changed";');
  expect(imported().stdout.toString().trim()).toBe("admitted");
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  expect((await lstat(`${snapshot.directory}/node_modules/application/index.js`)).mode % 512).toBe(
    0o755,
  );
});

test("installed closures preserve nested resolution, optional peers, package cycles and executable links", async () => {
  const cwd = `${root}/closures`;
  await Bun.write(
    `${cwd}/package.json`,
    JSON.stringify({
      dependencies: { application: "1" },
      devDependencies: { development: "1" },
      optionalDependencies: { absent: "1" },
    }),
  );
  await Bun.write(
    `${cwd}/node_modules/application/package.json`,
    JSON.stringify({
      main: "index.js",
      dependencies: { nested: "1" },
      optionalDependencies: { optional: "1", absent: "1" },
      peerDependencies: { development: "1" },
    }),
  );
  await Bun.write(`${cwd}/node_modules/application/index.js`, 'export {default} from "nested";');
  await Bun.write(
    `${cwd}/node_modules/application/node_modules/nested/package.json`,
    '{"main":"index.js","dependencies":{"application":"1"}}',
  );
  await Bun.write(
    `${cwd}/node_modules/application/node_modules/nested/index.js`,
    'export default "nested";',
  );
  await Bun.write(`${cwd}/node_modules/nested/package.json`, '{"main":"index.js"}');
  await Bun.write(`${cwd}/node_modules/nested/index.js`, 'export default "wrong";');
  for (const name of ["development", "optional"]) {
    await Bun.write(`${cwd}/node_modules/${name}/package.json`, '{"main":"index.js"}');
    await Bun.write(`${cwd}/node_modules/${name}/index.js`, `export default "${name}";`);
  }
  await Bun.write(
    `${cwd}/node_modules/development/cli.js`,
    'import value from "./index.js"; console.log(value);',
  );
  await import("node:fs/promises").then((fs) => fs.mkdir(`${cwd}/node_modules/.bin`));
  await symlink("../development/cli.js", `${cwd}/node_modules/.bin/development`);
  await symlink(`${cwd}/node_modules/development/cli.js`, `${cwd}/node_modules/.bin/absolute`);
  await symlink("../nested/index.js", `${cwd}/node_modules/development/linked.js`);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/closures-snapshot`);
  expect(
    Bun.spawnSync([process.execPath, "-e", 'import value from "application"; console.log(value)'], {
      cwd: snapshot.directory,
    })
      .stdout.toString()
      .trim(),
  ).toBe("nested");
  expect(
    Bun.spawnSync([process.execPath, "node_modules/.bin/development"], { cwd: snapshot.directory })
      .stdout.toString()
      .trim(),
  ).toBe("development");
  expect(await Bun.file(`${snapshot.directory}/node_modules/optional/index.js`).text()).toContain(
    "optional",
  );
  expect(
    await Bun.file(`${snapshot.directory}/node_modules/development/linked.js`).text(),
  ).toContain("wrong");
  expect(await Bun.file(`${snapshot.directory}/node_modules/nested/index.js`).text()).toContain(
    "wrong",
  );
  await Bun.write(`${cwd}/node_modules/development/cli.js`, "changed");
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  expect(await Bun.file(`${snapshot.directory}/node_modules/development/cli.js`).text()).toContain(
    "console.log(value)",
  );
  expect(
    Bun.spawnSync([process.execPath, "node_modules/.bin/absolute"], { cwd: snapshot.directory })
      .stdout.toString()
      .trim(),
  ).toBe("development");
});

test("undeclared installed package additions, deletions and modes invalidate admitted inputs", async () => {
  const cwd = `${root}/required`;
  await Bun.write(`${cwd}/package.json`, "{}");
  await mkdir(`${cwd}/node_modules`);
  const empty = await mutationInputIdentity(cwd);
  await Bun.write(`${cwd}/node_modules/undeclared/index.js`, 'export default "installed";');
  const installed = await mutationInputIdentity(cwd);
  expect(installed).not.toBe(empty);
  await chmod(`${cwd}/node_modules/undeclared/index.js`, 0o755);
  expect(await mutationInputIdentity(cwd)).not.toBe(installed);
  await rm(`${cwd}/node_modules/undeclared`, { recursive: true });
  expect(await mutationInputIdentity(cwd)).toBe(empty);
});

test("cyclic installed directory links refuse rather than retaining external live links", async () => {
  const cwd = `${root}/package-links`;
  await Bun.write(`${cwd}/package.json`, '{"dependencies":{"linked":"1"}}');
  await Bun.write(`${cwd}/node_modules/linked/package.json`, "{}");
  await symlink(".", `${cwd}/node_modules/linked/cycle`);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow("Cyclic installed input:");
});

test("installed executable links cannot escape the copied tree and ordinary executables retain their modes", async () => {
  const cwd = `${root}/bins`;
  await Bun.write(`${cwd}/node_modules/.bin/regular`, 'console.log("private");');
  await chmod(`${cwd}/node_modules/.bin/regular`, 0o755);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/bins-snapshot`);
  expect((await lstat(`${snapshot.directory}/node_modules/.bin/regular`)).mode % 512).toBe(0o755);
  await Bun.write(`${root}/foreign-bin`, 'console.log("live");');
  await symlink(`${root}/foreign-bin`, `${cwd}/node_modules/.bin/foreign`);
  await expect(admitMutationSnapshot(cwd, `${root}/bins-refused`)).rejects.toThrow(
    "Unsupported installed file link:",
  );
});

test("unsupported external package directory aliases refuse admission rather than changing resolution", async () => {
  const cwd = `${root}/linked-package`;
  await Bun.write(`${root}/external-package/index.js`, 'export default "admitted";');
  await mkdir(`${cwd}/node_modules`, { recursive: true });
  await symlink(`${root}/external-package`, `${cwd}/node_modules/application`);
  await expect(admitMutationSnapshot(cwd, `${root}/linked-package-snapshot`)).rejects.toThrow(
    "Unsupported installed directory link:",
  );
});

test("installed links to the immediate parent refuse admission", async () => {
  const cwd = `${root}/parent-link`;
  await mkdir(`${cwd}/node_modules`, { recursive: true });
  await symlink("..", `${cwd}/node_modules/parent`);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow(
    `Unsupported installed directory link: ${cwd}/node_modules/parent`,
  );
});

test("installed-root aliases must resolve to a complete node_modules root", async () => {
  const cwd = `${root}/wrong-root`;
  await mkdir(`${cwd}/packages`, { recursive: true });
  await symlink("packages", `${cwd}/node_modules`);
  await expect(admitMutationSnapshot(cwd, `${root}/wrong-root-snapshot`)).rejects.toThrow(
    `Unsupported installed root: ${cwd}/node_modules`,
  );
});

test("root aliases and empty directory names and modes participate in admission", async () => {
  const cwd = `${root}/root-alias`;
  for (const store of ["first", "second"])
    await mkdir(`${cwd}/${store}/node_modules/empty/deep`, { recursive: true });
  await symlink("first/node_modules", `${cwd}/node_modules`);
  await chmod(`${cwd}/node_modules`, 0o751);
  await chmod(`${cwd}/node_modules/empty`, 0o711);
  await chmod(`${cwd}/node_modules/empty/deep`, 0o750);
  const identity = await mutationInputIdentity(cwd);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/root-alias-snapshot`);
  expect(snapshot.identity).toBe(identity);
  for (const [name, mode] of [
    ["", 0o751],
    ["/empty", 0o711],
    ["/empty/deep", 0o750],
  ] as const) {
    const metadata = await lstat(`${snapshot.directory}/node_modules${name}`);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.mode % 512).toBe(mode);
  }
  await chmod(`${cwd}/node_modules/empty`, 0o755);
  expect(await mutationInputIdentity(cwd)).not.toBe(identity);
  await chmod(`${cwd}/node_modules/empty`, 0o711);
  expect(await mutationInputIdentity(cwd)).toBe(identity);
  await mkdir(`${cwd}/node_modules/another`);
  expect(await mutationInputIdentity(cwd)).not.toBe(identity);
  await rm(`${cwd}/node_modules/another`, { recursive: true });
  expect(await mutationInputIdentity(cwd)).toBe(identity);
  await rm(`${cwd}/node_modules`);
  // The same physical installation reached by different raw links has a different admitted identity.
  await symlink("./first/node_modules", `${cwd}/node_modules`);
  const rawAlias = await mutationInputIdentity(cwd);
  expect(rawAlias).not.toBe(identity);
  await rm(`${cwd}/node_modules`);
  await symlink("second/node_modules", `${cwd}/node_modules`);
  expect(await mutationInputIdentity(cwd)).not.toBe(rawAlias);
  expect((await lstat(`${snapshot.directory}/node_modules/empty/deep`)).mode % 512).toBe(0o750);
});

test("special installed inputs refuse admission without reading them as ordinary files", async () => {
  const cwd = `${root}/special-installed`;
  await mkdir(`${cwd}/node_modules`, { recursive: true });
  const file = `${cwd}/node_modules/pipe`;
  expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow(`Unsupported installed input: ${file}`);
});

test("installed traversal cannot admit a Git-ignored file outside node_modules", async () => {
  const cwd = `${root}/ignored-outside-installation`;
  await Bun.write(`${cwd}/.gitignore`, "Stryker was here\n");
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  await mkdir(`${cwd}/node_modules`);
  const identity = await mutationInputIdentity(cwd);
  await Bun.write(`${cwd}/Stryker was here`, "not an admitted installed input");
  expect(await mutationInputIdentity(cwd)).toBe(identity);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/ignored-outside-snapshot`);
  expect(await Bun.file(`${snapshot.directory}/Stryker was here`).exists()).toBe(false);
});

test("installed file links preserve relative import resolution inside the copied tree", async () => {
  const cwd = `${root}/file-link`;
  await Bun.write(
    `${cwd}/node_modules/application/package.json`,
    '{"main":"alias.js","type":"module"}',
  );
  await Bun.write(
    `${cwd}/node_modules/application/nested/entry.js`,
    'export {default} from "./value.js";',
  );
  await Bun.write(`${cwd}/node_modules/application/nested/value.js`, 'export default "nested";');
  await Bun.write(`${cwd}/node_modules/application/value.js`, 'export default "wrong";');
  await symlink("nested/entry.js", `${cwd}/node_modules/application/alias.js`);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/file-link-snapshot`);
  const imported = Bun.spawnSync(
    [process.execPath, "-e", 'import value from "application"; console.log(value);'],
    { cwd: snapshot.directory },
  );
  expect(imported.stdout.toString().trim()).toBe("nested");
});

test("cancelled input admission refuses before reading or copying source files", async () => {
  const cwd = `${root}/budget`;
  await Bun.write(`${cwd}/nested/source.ts`, "source");
  const controller = new AbortController();
  controller.abort(new Error("budget-exhausted"));
  await expect(mutationInputIdentity(cwd, controller.signal)).rejects.toThrow("budget-exhausted");
  await expect(
    admitMutationSnapshot(cwd, `${root}/budget-snapshot`, controller.signal),
  ).rejects.toThrow("budget-exhausted");
  expect(await Bun.file(`${root}/budget-snapshot/nested/source.ts`).exists()).toBe(false);
});

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

test("internal source file links freeze private imports and invalidate edited targets", async () => {
  const cwd = `${root}/source-file-link`;
  await Bun.write(`${cwd}/physical/entry.js`, 'export {default} from "./value.js";');
  await Bun.write(`${cwd}/physical/value.js`, 'export default "admitted";');
  await Bun.write(`${cwd}/value.js`, 'export default "flattened";');
  await symlink("physical/entry.js", `${cwd}/alias.js`);
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "add", "."], { cwd }).exitCode).toBe(0);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/source-file-link-snapshot`);
  function imported(directory: string) {
    const result = Bun.spawnSync(
      [process.execPath, "-e", 'import value from "./alias.js"; console.log(value);'],
      { cwd: directory },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  }

  expect(imported(cwd)).toBe("admitted");
  expect(imported(snapshot.directory)).toBe("admitted");
  expect((await lstat(`${snapshot.directory}/alias.js`)).isSymbolicLink()).toBe(true);
  expect(await readlink(`${snapshot.directory}/alias.js`)).toBe("physical/entry.js");
  expect(await realpath(`${snapshot.directory}/alias.js`)).toBe(
    `${snapshot.directory}/physical/entry.js`,
  );
  await Bun.write(`${cwd}/physical/value.js`, 'export default "modified";');
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  expect(imported(snapshot.directory)).toBe("admitted");
});

test("external source links are refused rather than retaining mutable external inputs", async () => {
  const cwd = `${root}/links`;
  await Bun.write(`${root}/outside-source`, "unsafe");
  await mkdir(cwd);
  await symlink(`${root}/outside-source`, `${cwd}/linked`);
  await expect(admitMutationSnapshot(cwd, `${root}/links-snapshot`)).rejects.toThrow(
    "Unsupported snapshot input: linked",
  );
});

test("source alias spelling and retargeting invalidate identical entry bytes without changing frozen imports", async () => {
  const cwd = `${root}/source-retarget`;
  for (const directory of ["first", "other"]) {
    await Bun.write(`${cwd}/${directory}/entry.js`, 'export {default} from "./value.js";');
    await Bun.write(`${cwd}/${directory}/value.js`, `export default "${directory}";`);
  }
  await symlink("first/entry.js", `${cwd}/alias.js`);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/source-retarget-snapshot`);
  await rm(`${cwd}/alias.js`);
  await symlink("./first/entry.js", `${cwd}/alias.js`);
  const spelling = await mutationInputIdentity(cwd);
  expect(spelling).not.toBe(snapshot.identity);
  await rm(`${cwd}/alias.js`);
  await symlink("other/entry.js", `${cwd}/alias.js`);
  expect(await mutationInputIdentity(cwd)).not.toBe(spelling);
  for (const [directory, expected] of [
    [cwd, "other"],
    [snapshot.directory, "first"],
  ] as const) {
    const result = Bun.spawnSync(
      [process.execPath, "-e", 'import value from "./alias.js"; console.log(value);'],
      { cwd: directory },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe(expected);
  }
});

test("absolute source aliases resolve privately and target bytes and modes remain frozen", async () => {
  const cwd = `${root}/absolute-source`;
  await Bun.write(`${cwd}/nested/target`, "first");
  await chmod(`${cwd}/nested/target`, 0o751);
  await symlink(`${cwd}/nested/target`, `${cwd}/alias`);
  const snapshot = await admitMutationSnapshot(cwd, `${root}/absolute-source-snapshot`);
  expect(await readlink(`${snapshot.directory}/alias`)).toBe("nested/target");
  expect(await realpath(`${snapshot.directory}/alias`)).toBe(`${snapshot.directory}/nested/target`);
  expect((await lstat(`${snapshot.directory}/nested/target`)).mode % 512).toBe(0o751);
  await Bun.write(`${cwd}/nested/target`, "other");
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  expect(await Bun.file(`${snapshot.directory}/alias`).text()).toBe("first");
  await Bun.write(`${cwd}/nested/target`, "first");
  expect(await mutationInputIdentity(cwd)).toBe(snapshot.identity);
  await chmod(`${cwd}/nested/target`, 0o755);
  expect(await mutationInputIdentity(cwd)).not.toBe(snapshot.identity);
  await rm(`${cwd}/nested/target`);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow("Unsupported snapshot input: alias");
  expect(await Bun.file(`${snapshot.directory}/alias`).text()).toBe("first");
});

test.each([
  ["directory", "nested"],
  ["dangling", "missing"],
  ["cycle", "alias"],
  ["chain", "second-alias"],
  ["excluded", ".operator/private"],
  ["cancelled", ".operator/../regular"],
])("unsupported source %s aliases refuse admission", async (name, target) => {
  const cwd = `${root}/refused-source-${name}`;
  await Bun.write(`${cwd}/regular`, "safe");
  await mkdir(`${cwd}/nested`);
  await symlink("regular", `${cwd}/second-alias`);
  await symlink(target, `${cwd}/alias`);
  const destination = `${root}/refused-source-${name}-snapshot`;
  await expect(admitMutationSnapshot(cwd, destination)).rejects.toThrow(
    "Unsupported snapshot input: alias",
  );
  await expect(lstat(`${destination}/alias`)).rejects.toHaveProperty("code", "ENOENT");
});

test("source aliases cannot admit ignored targets or follow source ancestor aliases", async () => {
  const cwd = `${root}/source-admission-boundary`;
  await Bun.write(`${cwd}/.gitignore`, "ignored\n");
  await Bun.write(`${cwd}/ignored`, "not admitted");
  await Bun.write(`${cwd}/nested/target`, "admitted");
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "add", "."], { cwd }).exitCode).toBe(0);
  await symlink("ignored", `${cwd}/alias`);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow("Unsupported snapshot input: alias");
  await rm(`${cwd}/alias`);
  await rm(`${cwd}/nested`, { recursive: true });
  await Bun.write(`${root}/external-source-parent/target`, "external");
  await symlink(`${root}/external-source-parent`, `${cwd}/nested`);
  await symlink("nested/target", `${cwd}/alias`);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow("Unsupported source ancestor:");
  const destination = `${root}/source-admission-boundary-snapshot`;
  await expect(admitMutationSnapshot(cwd, destination)).rejects.toThrow(
    "Unsupported source ancestor:",
  );
  expect(await Bun.file(`${destination}/nested/target`).exists()).toBe(false);
});

test("tracked nested deletions remain absent and tracked alias targets cannot disappear", async () => {
  const cwd = `${root}/source-tracked-deletions`;
  await Bun.write(`${cwd}/removed/nested/file`, "deleted");
  await Bun.write(`${cwd}/target`, "admitted");
  await symlink("target", `${cwd}/alias`);
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "add", "."], { cwd }).exitCode).toBe(0);
  await rm(`${cwd}/removed`, { recursive: true });
  const destination = `${root}/source-tracked-deletions-snapshot`;
  await expect(admitMutationSnapshot(cwd, destination)).resolves.toMatchObject({
    directory: destination,
  });
  expect(await Bun.file(`${destination}/removed/nested/file`).exists()).toBe(false);
  expect(await Bun.file(`${destination}/alias`).text()).toBe("admitted");
  await rm(`${cwd}/target`);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow("Unsupported snapshot input: alias");
  await expect(
    admitMutationSnapshot(cwd, `${root}/source-tracked-missing-target-snapshot`),
  ).rejects.toThrow("Unsupported snapshot input: alias");
});

test("a tracked file replaced by a directory refuses before reading or copying it", async () => {
  const cwd = `${root}/source-directory-replacement`;
  await Bun.write(`${cwd}/source`, "regular");
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "add", "."], { cwd }).exitCode).toBe(0);
  await rm(`${cwd}/source`);
  await mkdir(`${cwd}/source`);
  await expect(mutationInputIdentity(cwd)).rejects.toThrow("Unsupported snapshot input: source");
  const destination = `${root}/source-directory-replacement-snapshot`;
  await expect(admitMutationSnapshot(cwd, destination)).rejects.toThrow(
    "Unsupported snapshot input: source",
  );
  await expect(lstat(`${destination}/source`)).rejects.toHaveProperty("code", "ENOENT");
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
  expect(await Bun.file(`${snapshot.directory}/node_modules/private`).text()).toBe("excluded");
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
    const admission = admitMutationSnapshot(cwd, `${root}/changing-snapshot`);
    await expect(admission).rejects.toThrow("Mutation inputs changed during snapshot admission.");
    await expect(admission).rejects.toHaveProperty("cause", "inputs-changed");
  } finally {
    writer.kill();
    await writer.exited;
  }
});
