import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { SkillInstall } from "./main.ts";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const bundledSkillsRoot = new URL("../../skills/", import.meta.url).pathname;
const projectRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    projectRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function makeProject(): Promise<string> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`.quiet();
  projectRoots.push(root);
  return root;
}

async function runOperator(root: string, args: string[]) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function filesUnder(directory: string): Promise<string[]> {
  return (
    await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true }))
  ).toSorted();
}

describe("operator install", () => {
  test("refuses to guess a target", async () => {
    const root = await makeProject();

    const result = await runOperator(root, ["install", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "invalid",
      reason: "missing_target",
      operation: "install",
    });
    expect(await filesUnder(root)).toEqual([]);
  });

  test("copies every bundled skill asset into the OpenCode target", async () => {
    const root = await makeProject();

    const result = await runOperator(root, ["install", "--opencode", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "completed",
      reason: "skills_installed",
    });
    expect(await filesUnder(`${root}/.agents/skills/operator`)).toEqual(
      await filesUnder(`${bundledSkillsRoot}operator`),
    );
  });

  test("copies into both targets when both are selected", async () => {
    const root = await makeProject();

    const result = await runOperator(root, ["install", "--opencode", "--claude", "--json"]);

    expect(result.exitCode).toBe(0);
    const bundled = await filesUnder(`${bundledSkillsRoot}operator`);
    expect(await filesUnder(`${root}/.agents/skills/operator`)).toEqual(bundled);
    expect(await filesUnder(`${root}/.claude/skills/operator`)).toEqual(bundled);
  });

  test("adopts a matching copy without writing it again", async () => {
    const root = await makeProject();
    await runOperator(root, ["install", "--claude"]);
    const installedSkill = `${root}/.claude/skills/operator/SKILL.md`;
    const firstWrite = (await Bun.file(installedSkill).stat()).mtimeMs;

    const result = await runOperator(root, ["install", "--claude", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "completed",
      reason: "skills_already_installed",
    });
    expect((await Bun.file(installedSkill).stat()).mtimeMs).toBe(firstWrite);
  });

  test("preserves a changed copy and reports the conflicting path", async () => {
    const root = await makeProject();
    await runOperator(root, ["install", "--opencode", "--claude"]);
    const changedPath = `${root}/.claude/skills/operator/SKILL.md`;
    await Bun.write(changedPath, "# my own edit\n");

    const result = await runOperator(root, ["install", "--opencode", "--claude", "--json"]);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "conflict",
      reason: "skill_copy_conflict",
      blockers: [
        {
          reason: "skill_copy_modified",
          skill: "operator",
          target: "claude-code",
          paths: [".claude/skills/operator/SKILL.md"],
        },
      ],
    });
    expect(await Bun.file(changedPath).text()).toBe("# my own edit\n");
  });

  test("writes nothing to an unaffected target while a conflict stands", async () => {
    const root = await makeProject();
    await Bun.write(`${root}/.claude/skills/operator/SKILL.md`, "# my own edit\n");

    const result = await runOperator(root, ["install", "--opencode", "--claude", "--json"]);

    expect(result.exitCode).toBe(4);
    expect(await filesUnder(root)).toEqual([".claude/skills/operator/SKILL.md"]);
  });
});

describe("Operator release skill contents", () => {
  test("identifies the bundled skills with one stable content hash", async () => {
    const [first, second] = await Promise.all([SkillInstall.identity(), SkillInstall.identity()]);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});
