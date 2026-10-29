import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../modules/environment/main.ts";
import { changedRanges, parseMutationArgs, selectMutationUnits } from "./mutation-selection.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-mutation-selection-"));
afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

test("selection requires explicit units or a ref, with optional unit limits", () => {
  expect(parseMutationArgs([])).toHaveProperty("error");
  expect(parseMutationArgs(["--since"])).toHaveProperty("error");
  expect(parseMutationArgs(["--since", "HEAD", "--since", "main"])).toHaveProperty("error");
  expect(parseMutationArgs(["--bad"])).toHaveProperty("error");
  expect(parseMutationArgs(["--since", "main", "lib/a.ts"])).toEqual({
    since: "main",
    paths: ["lib/a.ts"],
  });
  expect(parseMutationArgs(["--", "-unit.ts"])).toEqual({ since: undefined, paths: ["-unit.ts"] });
});

test("zero-context hunks select current lines, not removed lines or diff content", () => {
  expect(
    changedRanges(
      "@@ -1 +1 @@\n-a\n+b\n@@ -4,0 +5,3 @@\n+x\n+y\n+z\n@@ -10,2 +12,0 @@\n-old\n-old\n+@@ -1 +50 @@\n",
    ),
  ).toEqual([
    { start: 1, end: 1 },
    { start: 5, end: 7 },
  ]);
});

test("the longest unit stem owns a test, and selection deduplicates normalized paths", async () => {
  for (const [name, source] of Object.entries({
    "lib/name.ts": "export const n = 1;\n",
    "lib/name.detail.ts": "export const n = 2;\n",
    "lib/name.test.ts": "",
    "lib/name.refusal.test.ts": "",
    "lib/name.detail.test.ts": "",
    "other/name.test.ts": "",
  }))
    await Bun.write(path.join(root, name), source);
  const selected = await selectMutationUnits(
    { paths: ["lib/name.refusal.test.ts", "./lib/name.ts"] },
    root,
  );
  expect(selected).toEqual({
    skipped: 0,
    units: [
      {
        name: "lib/name.ts",
        source: "export const n = 1;\n",
        tests: ["./lib/name.refusal.test.ts", "./lib/name.test.ts"],
        patterns: ["lib/name.ts"],
      },
    ],
  });
  const detail = await selectMutationUnits({ paths: ["lib/name.detail.test.ts"] }, root);
  expect(detail).toMatchObject({
    units: [{ name: "lib/name.detail.ts", tests: ["./lib/name.detail.test.ts"] }],
  });
});

test("symlink targets refuse before reading their content", async () => {
  const directory = await mkdtemp(`${root}/link-`);
  await Bun.write(path.join(directory, "actual.ts"), "export const n = 1;\n");
  await symlink(path.join(directory, "actual.ts"), path.join(directory, "linked.ts"));
  expect(await selectMutationUnits({ paths: ["linked.ts"] }, directory)).toEqual({
    error: "Target must not use a symbolic link: linked.ts",
  });
});

test("a link above the repository root is not a target link", async () => {
  const directory = await mkdtemp(`${root}/real-`);
  await Bun.write(path.join(directory, "lib/unit.ts"), "export const n = 1;\n");
  await symlink(directory, `${directory}-linked`);
  expect(
    await selectMutationUnits({ paths: ["lib/unit.ts"] }, `${directory}-linked`),
  ).toMatchObject({ units: [{ name: "lib/unit.ts", source: "export const n = 1;\n" }] });
});

test("option errors name the problem, and a ref may contain a dash after its first character", () => {
  expect(parseMutationArgs([])).toEqual({ error: "Select a unit or --since <ref>." });
  expect(parseMutationArgs(["--since", "-x"])).toEqual({
    error: "--since needs one explicit Git ref.",
  });
  expect(parseMutationArgs(["--bad"])).toEqual({ error: "Unknown option: --bad" });
  expect(parseMutationArgs(["--since", "topic-"])).toEqual({ since: "topic-", paths: [] });
  expect(parseMutationArgs(["lib/a.ts", "--since", "main", "lib/b.ts"])).toEqual({
    since: "main",
    paths: ["lib/a.ts", "lib/b.ts"],
  });
});

test("hunk headers with several digits select their current lines", () => {
  expect(changedRanges("@@ -12 +12 @@\n@@ -100,25 +120,30 @@\n")).toEqual([
    { start: 12, end: 12 },
    { start: 120, end: 149 },
  ]);
});

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(`${root}/project-`);
  for (const [name, source] of Object.entries(files))
    await Bun.write(path.join(directory, name), source);
  return directory;
}

test("explicit targets outside eligible code, missing, or without a unit are refused", async () => {
  const directory = await project({ "lib/a.ts": "export const a = 1;\n" });
  await Bun.write(path.join(directory, "../outside.ts"), "export const o = 1;\n");
  const refusals: [string, string][] = [
    ["..", "Target is outside eligible repository code: .."],
    ["../outside.ts", "Target is outside eligible repository code: ../outside.ts"],
    ["node_modules", "Target is outside eligible repository code: node_modules"],
    ["node_modules/a.ts", "Target is outside eligible repository code: node_modules/a.ts"],
    ["lib/.git/a.ts", "Target is outside eligible repository code: lib/.git/a.ts"],
    [".operator/a.ts", "Target is outside eligible repository code: .operator/a.ts"],
    ["lib\\a.ts", "Target is outside eligible repository code: lib\\a.ts"],
    ["lib/missing.ts", "Target file does not exist: lib/missing.ts"],
    ["lib/missing.test.ts", "Target file does not exist: lib/missing.test.ts"],
  ];
  for (const [target, error] of refusals) {
    expect(await selectMutationUnits({ paths: [target] }, directory), target).toEqual({ error });
  }
  await Bun.write(path.join(directory, "lib/orphan.test.ts"), "");
  expect(await selectMutationUnits({ paths: ["lib/orphan.test.ts"] }, directory)).toEqual({
    error: "No unit for lib/orphan.test.ts",
  });
});

test("names that only contain a refused folder name stay eligible", async () => {
  const directory = await project({
    "lib/node_modules_notes.ts": "export const a = 1;\n",
    "lib/my.operator/a.ts": "export const b = 1;\n",
  });
  const selected = await selectMutationUnits(
    { paths: ["lib/node_modules_notes.ts", "lib/my.operator/a.ts"] },
    directory,
  );
  expect(selected).toMatchObject({
    skipped: 0,
    units: [{ name: "lib/node_modules_notes.ts" }, { name: "lib/my.operator/a.ts" }],
  });
});

test("a linked beside-test is refused", async () => {
  const directory = await project({ "lib/u.ts": "export const u = 1;\n", "real.test.ts": "" });
  await symlink(path.join(directory, "real.test.ts"), path.join(directory, "lib/u.test.ts"));
  expect(await selectMutationUnits({ paths: ["lib/u.ts"] }, directory)).toEqual({
    error: "Target must not use a symbolic link: lib/u.test.ts",
  });
});

test("excluded and no-logic units are skipped, and bad suppressions are listed by line", async () => {
  const directory = await project({
    "lib/a-fixture.ts": "export const a = 1;\n",
    "lib/plain.ts": "// Stryker disable all: no logic\nexport type A = string;\n",
    "lib/windows.ts": "// Stryker disable all: no logic\r\nexport type B = string;\r\n",
    "lib/bad.ts":
      "// Stryker disable all\nconst a = 1;\n// Stryker disable next-line StringLiteral\n",
  });
  expect(
    await selectMutationUnits(
      { paths: ["lib/a-fixture.ts", "lib/plain.ts", "lib/windows.ts"] },
      directory,
    ),
  ).toEqual({ units: [], skipped: 3 });
  expect(await selectMutationUnits({ paths: ["lib/bad.ts"] }, directory)).toEqual({
    error: [
      "lib/bad.ts:1: suppression requires equivalent: or no rule: with an explanation.",
      "lib/bad.ts:3: suppression requires equivalent: or no rule: with an explanation.",
    ].join("\n"),
  });
});

test("glob characters in a unit name are escaped as literal character classes", async () => {
  const directory = await project({ "lib/a[1]{b}(c)!+@*?.ts": "export const a = 1;\n" });
  expect(await selectMutationUnits({ paths: ["lib/a[1]{b}(c)!+@*?.ts"] }, directory)).toMatchObject(
    {
      units: [{ patterns: ["lib/a[[]1[]][{]b[}][(]c[)][!][+][@][*][?].ts"], tests: [] }],
    },
  );
});

function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    {
      cwd,
      env: Environment.child({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return child.stdout.toString().trim();
}

test("--since selects changed current lines and new units, and skips other changes", async () => {
  const directory = await project({
    "lib/a.ts": "one;\ntwo;\nthree;\nfour;\n",
    "lib/b.ts": "one;\ntwo;\n",
    "lib/gone.ts": "one;\ntwo;\n",
    "lib/a.test.ts": "",
    ".operator/state.ts": "one;\n",
    "notes.md": "one\n",
  });
  git(directory, "init", "--quiet");
  git(directory, "add", "--all");
  git(directory, "commit", "--quiet", "--message", "base");
  await Bun.write(path.join(directory, "lib/a.ts"), "one;\nTWO;\nTHREE;\nfour;\nfive;\n");
  await Bun.write(path.join(directory, "lib/b.ts"), "one;\n");
  await Bun.write(path.join(directory, "lib/gone.ts"), "ONE;\ntwo;\n");
  await Bun.write(path.join(directory, "lib/a.test.ts"), "changed\n");
  await Bun.write(path.join(directory, ".operator/state.ts"), "changed\n");
  await Bun.write(path.join(directory, ".operator/new.ts"), "new\n");
  await Bun.write(path.join(directory, "notes.md"), "changed\n");
  await Bun.write(path.join(directory, "lib/new.ts"), "fresh;\n");
  await Bun.write(path.join(directory, "lib/new.test.ts"), "");

  expect(await selectMutationUnits({ paths: [], since: "HEAD" }, directory)).toEqual({
    skipped: 0,
    units: [
      {
        name: "lib/a.ts",
        source: "one;\nTWO;\nTHREE;\nfour;\nfive;\n",
        tests: ["./lib/a.test.ts"],
        patterns: ["lib/a.ts:2-3", "lib/a.ts:5-5"],
      },
      { name: "lib/gone.ts", source: "ONE;\ntwo;\n", tests: [], patterns: ["lib/gone.ts:1-1"] },
      {
        name: "lib/new.ts",
        source: "fresh;\n",
        tests: ["./lib/new.test.ts"],
        patterns: ["lib/new.ts"],
      },
    ],
  });
  expect(
    await selectMutationUnits({ paths: ["lib/new.test.ts"], since: "HEAD" }, directory),
  ).toMatchObject({ units: [{ name: "lib/new.ts" }] });
  const unknown = await selectMutationUnits({ paths: [], since: "no-such-ref" }, directory);
  // Git's own reason follows, trimmed of its final newline.
  expect("error" in unknown && unknown.error).toMatch(/^Git selection failed: fatal: \S.*\S$/s);
});

test("--since refuses a changed unit that is a link", async () => {
  const directory = await project({ "lib/real.ts": "one\n" });
  await symlink("real.ts", path.join(directory, "lib/link.ts"));
  git(directory, "init", "--quiet");
  git(directory, "add", "--all");
  git(directory, "commit", "--quiet", "--message", "base");
  await Bun.write(path.join(directory, "lib/other.ts"), "one\n");
  await rm(path.join(directory, "lib/link.ts"));
  await symlink("other.ts", path.join(directory, "lib/link.ts"));
  expect(await selectMutationUnits({ paths: [], since: "HEAD" }, directory)).toEqual({
    error: "Target must not use a symbolic link: lib/link.ts",
  });
});

async function committed(files: Record<string, string>): Promise<string> {
  const directory = await project(files);
  git(directory, "init", "--quiet");
  git(directory, "add", "--all");
  git(directory, "commit", "--quiet", "--message", "base");
  return directory;
}

async function removeObject(directory: string, revision: string): Promise<void> {
  const id = git(directory, "rev-parse", revision);
  await rm(path.join(directory, ".git/objects", id.slice(0, 2), id.slice(2)));
}

test("--since reports a Git failure in each listing step", async () => {
  // A corrupt index stops the untracked listing.
  const index = await committed({ "lib/a.ts": "one;\n" });
  await Bun.write(path.join(index, ".git/index"), "corrupt");
  expect(await selectMutationUnits({ paths: [], since: "HEAD" }, index)).toEqual({
    error: expect.stringContaining("Git selection failed: fatal: ") as string,
  });

  // A missing tree stops the changed-name listing after the ref resolves.
  const tree = await committed({ "lib/a.ts": "one;\n" });
  await removeObject(tree, "HEAD^{tree}");
  expect(await selectMutationUnits({ paths: [], since: "HEAD" }, tree)).toEqual({
    error: expect.stringContaining("Git selection failed: ") as string,
  });

  // A missing old blob stops the line diff of a staged change.
  const blob = await committed({ "lib/a.ts": "one;\n" });
  const old = git(blob, "rev-parse", "HEAD:lib/a.ts");
  await Bun.write(path.join(blob, "lib/a.ts"), "two;\n");
  git(blob, "add", "lib/a.ts");
  await rm(path.join(blob, ".git/objects", old.slice(0, 2), old.slice(2)));
  expect(await selectMutationUnits({ paths: [], since: "HEAD" }, blob)).toEqual({
    error: expect.stringContaining("Git selection failed: fatal: unable to read") as string,
  });
});

test("an explicit unit selects itself even when a longer name exists beside it", async () => {
  const directory = await project({ "lib/x.ts": "one;\n", "lib/x.ts.ts": "two;\n" });
  expect(await selectMutationUnits({ paths: ["lib/x.ts"] }, directory)).toMatchObject({
    units: [{ name: "lib/x.ts", source: "one;\n" }],
  });
});
