import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { chmod, cp, lstat, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { sha256 } from "../../lib/sha256.ts";

let root = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-owned-skills-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "install", ...args, "--json"], {
    cwd: root,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: JSON.parse(stdout) as unknown, stderr };
}

test("copies complete owned skills personally for both hosts without project writes", async () => {
  const result = await run(["--opencode", "--claude"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.output).toMatchObject({ reason: "skills_installed" });
  for (const host of [`${root}/config/opencode/skills`, `${root}/home/.claude/skills`]) {
    expect(await Bun.file(`${host}/deep-modules/module-shape.md`).text()).toBe(
      await Bun.file(new URL("../../skills/deep-modules/module-shape.md", import.meta.url)).text(),
    );
    expect(await Bun.file(`${host}/super-agent/SKILL.md`).exists()).toBe(true);
    expect(await Bun.file(`${host}/worker-agent/SKILL.md`).exists()).toBe(true);
  }
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
  expect(await Bun.file(`${root}/.agents/skills/bun/SKILL.md`).exists()).toBe(false);
});

test("matching copies and their ledger stay unwritten on a repeated install", async () => {
  expect((await run(["--opencode", "--claude"])).code).toBe(0);
  const file = `${root}/home/.claude/skills/bun/SKILL.md`;
  const ledger = `${root}/state/operator/owned-skills.json`;
  const before = await lstat(file);
  const recorded = await lstat(ledger);
  expect(await run(["--opencode", "--claude"])).toMatchObject({
    code: 0,
    output: { reason: "skills_already_installed" },
  });
  expect((await lstat(file)).mtimeMs).toBe(before.mtimeMs);
  expect((await lstat(ledger)).mtimeMs).toBe(recorded.mtimeMs);
});

test.each(["modified", "extra", "missing", "linked"])(
  "refuses %s managed content without changing either host or the ledger",
  async (kind) => {
    expect((await run(["--claude"])).code).toBe(0);
    const skill = `${root}/home/.claude/skills/bun`;
    if (kind === "modified") await Bun.write(`${skill}/SKILL.md`, "my edit\n");
    if (kind === "extra") await Bun.write(`${skill}/.private`, "my extra file\n");
    if (kind === "missing") await rm(`${skill}/SKILL.md`);
    if (kind === "linked") {
      await rm(`${skill}/SKILL.md`);
      await Bun.write(`${root}/outside`, "external\n");
      await symlink(`${root}/outside`, `${skill}/SKILL.md`);
    }
    const ledger = await Bun.file(`${root}/state/operator/owned-skills.json`).text();
    expect(await run(["--opencode", "--claude"])).toMatchObject({
      code: 4,
      output: { reason: "skill_copy_conflict" },
    });
    expect(await Bun.file(`${root}/config/opencode/skills/bun/SKILL.md`).exists()).toBe(false);
    expect(await Bun.file(`${root}/state/operator/owned-skills.json`).text()).toBe(ledger);
    if (kind === "modified") expect(await Bun.file(`${skill}/SKILL.md`).text()).toBe("my edit\n");
    if (kind === "extra")
      expect(await Bun.file(`${skill}/.private`).text()).toBe("my extra file\n");
    if (kind === "linked") expect(await Bun.file(`${root}/outside`).text()).toBe("external\n");
  },
);

test("an unrelated retired role skill blocks installation without adoption or removal", async () => {
  await Bun.write(`${root}/home/.claude/skills/operator/SKILL.md`, "unrelated\n", {
    createPath: true,
  });
  expect((await run(["--claude"])).code).toBe(4);
  expect(await Bun.file(`${root}/home/.claude/skills/operator/SKILL.md`).text()).toBe(
    "unrelated\n",
  );
  expect(await Bun.file(`${root}/state/operator/owned-skills.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/home/.claude/skills/super-agent/SKILL.md`).exists()).toBe(false);
});

test("removes unchanged old-name managed roles through the public CLI only with device proof", async () => {
  const entries: Record<string, Record<string, string>> = {};
  for (const host of [`${root}/config/opencode/skills`, `${root}/home/.claude/skills`]) {
    for (const name of ["operator", "operative"]) {
      const destination = `${host}/${name}`;
      await Bun.write(`${destination}/SKILL.md`, "previous role\n", { createPath: true });
      entries[destination] = { "/": "directory", "SKILL.md": sha256("previous role\n") };
    }
  }
  await Bun.write(
    `${root}/state/operator/owned-skills.json`,
    JSON.stringify({ version: 1, entries }),
    { createPath: true },
  );
  expect((await run(["--opencode", "--claude"])).code).toBe(0);
  for (const file of Object.keys(entries))
    expect(await Bun.file(`${file}/SKILL.md`).exists()).toBe(false);
  expect(await Bun.file(`${root}/home/.claude/skills/super-agent/SKILL.md`).exists()).toBe(true);
});

test.each(["{bad", '{"version":2,"entries":{}}'])(
  "an invalid ledger %s blocks writes and stays unchanged",
  async (text) => {
    await Bun.write(`${root}/state/operator/owned-skills.json`, text, { createPath: true });
    expect(await run(["--claude"])).toMatchObject({
      code: 1,
      output: { reason: "skills_ledger_invalid" },
    });
    expect(await Bun.file(`${root}/state/operator/owned-skills.json`).text()).toBe(text);
    expect(await Bun.file(`${root}/home/.claude/skills/bun/SKILL.md`).exists()).toBe(false);
  },
);

test("check mode follows complete skill links and leaves host folders and state unchanged", async () => {
  const source = Bun.fileURLToPath(new URL("../../skills", import.meta.url));
  await cp(source, `${root}/package skills`, { recursive: true });
  await mkdir(`${root}/home/.claude`, { recursive: true });
  await symlink(`${root}/package skills`, `${root}/home/.claude/skills`);
  const link = await readlink(`${root}/home/.claude/skills`);
  expect(await run(["--claude", "--check"])).toMatchObject({
    code: 0,
    output: { reason: "skills_checked", data: { checkOnly: true } },
  });
  expect(await readlink(`${root}/home/.claude/skills`)).toBe(link);
  expect(await Bun.file(`${root}/state/operator/owned-skills.json`).exists()).toBe(false);
  await Bun.write(`${root}/package skills/deep-modules/module-shape.md`, "changed asset\n");
  expect((await run(["--claude", "--check"])).code).toBe(4);
  expect(await Bun.file(`${root}/package skills/deep-modules/module-shape.md`).text()).toBe(
    "changed asset\n",
  );
  expect((await run(["--claude"])).code).toBe(4);
});

test("missing check-only contents create no host or state folders", async () => {
  expect((await run(["--opencode", "--claude", "--check"])).code).toBe(4);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([]);
});

test("a read-only skill folder is preserved and blocks the other host", async () => {
  await mkdir(`${root}/home/.claude/skills`, { recursive: true });
  await chmod(`${root}/home/.claude/skills`, 0o555);
  try {
    expect((await run(["--opencode", "--claude"])).code).toBe(4);
    expect(await Bun.file(`${root}/config/opencode/skills/bun/SKILL.md`).exists()).toBe(false);
  } finally {
    await chmod(`${root}/home/.claude/skills`, 0o755);
  }
});

test("simultaneous installs serialize and preserve complete contents", async () => {
  const results = await Promise.all([
    run(["--claude", "--opencode"]),
    run(["--claude", "--opencode"]),
  ]);
  expect(results.map((result) => result.code)).toEqual([0, 0]);
  expect((await run(["--claude", "--opencode", "--check"])).code).toBe(0);
});

test.each(
  [["--claude", "--claude"], ["--unknown"], ["matt", "--claude"], ["--check"]].map((args) => ({
    args,
  })),
)("invalid flags %j have no effects", async ({ args }) => {
  expect((await run(args)).code).toBe(2);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([]);
});
