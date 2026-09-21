import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const projectRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    projectRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-setup-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`.quiet();
  projectRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(`${root}/${path}`, content, { createPath: true });
  }
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

async function runJson(root: string, args: string[]) {
  const result = await runOperator(root, [...args, "--json"]);
  return { ...result, json: JSON.parse(result.stdout) };
}

async function filesUnder(root: string): Promise<string[]> {
  return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toSorted();
}

async function planAndApply(root: string, targets: string[]) {
  const plan = await runJson(root, ["setup", "plan", ...targets]);
  return runJson(root, ["setup", "apply", ...targets, "--approved-plan", plan.json.data.planId]);
}

describe("operator setup plan", () => {
  test("refuses to guess a target", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "plan"]);

    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ outcome: "invalid", reason: "missing_target" });
    expect(await filesUnder(root)).toEqual([]);
  });

  test("shows the exact proposed changes and writes nothing", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "plan", "--claude"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("plan_ready");
    expect(result.json.data.changes.map((change: { path: string }) => change.path)).toEqual([
      ".operator/config.schema.json",
      ".operator/config.json",
      ".gitignore",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(result.json.data.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(await filesUnder(root)).toEqual([]);
  });

  test("leaves CLAUDE.md alone when only OpenCode is selected", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "plan", "--opencode"]);

    expect(result.json.data.changes.map((change: { path: string }) => change.path)).not.toContain(
      "CLAUDE.md",
    );
  });
});

describe("operator setup apply", () => {
  test("refuses to write without an approved plan", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "apply", "--claude"]);

    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({
      outcome: "missing-condition",
      reason: "approval_required",
    });
    expect(result.json.data.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(await filesUnder(root)).toEqual([]);
  });

  test("refuses an approval that does not match the current plan", async () => {
    const root = await makeProject();

    const result = await runJson(root, [
      "setup",
      "apply",
      "--claude",
      "--approved-plan",
      "0".repeat(64),
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("approval_stale");
    expect(await filesUnder(root)).toEqual([]);
  });

  test("refuses an approval taken for another target", async () => {
    const root = await makeProject();
    const claudePlan = await runJson(root, ["setup", "plan", "--claude"]);

    const result = await runJson(root, [
      "setup",
      "apply",
      "--opencode",
      "--approved-plan",
      claudePlan.json.data.planId,
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("approval_stale");
    expect(await filesUnder(root)).toEqual([]);
  });

  test("applies the approved plan", async () => {
    const root = await makeProject();

    const result = await planAndApply(root, ["--claude"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("setup_applied");
    expect(await filesUnder(root)).toEqual([
      ".gitignore",
      ".operator/config.json",
      ".operator/config.schema.json",
      ".operator/local/setup-journal.json",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(await Bun.file(`${root}/.gitignore`).text()).toContain("/.operator/");
    expect(await Bun.file(`${root}/CLAUDE.md`).text()).toContain("@AGENTS.md");
    expect(await Bun.file(`${root}/AGENTS.md`).text()).toContain("<!-- operator:instructions -->");
    expect(JSON.parse(await Bun.file(`${root}/.operator/config.json`).text())).toEqual({
      $schema: "./config.schema.json",
      operator: {},
      crew: {},
    });
  });

  test("makes no write when the plan is rerun unchanged", async () => {
    const root = await makeProject();
    await planAndApply(root, ["--claude"]);
    const before = await Promise.all(
      (await filesUnder(root)).map(async (path) => [
        path,
        (await Bun.file(`${root}/${path}`).stat()).mtimeMs,
      ]),
    );

    const plan = await runJson(root, ["setup", "plan", "--claude"]);
    const result = await planAndApply(root, ["--claude"]);

    expect(plan.json.reason).toBe("already_configured");
    expect(plan.json.data.changes).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("already_configured");
    const after = await Promise.all(
      (await filesUnder(root)).map(async (path) => [
        path,
        (await Bun.file(`${root}/${path}`).stat()).mtimeMs,
      ]),
    );
    expect(after).toEqual(before);
  });

  test("preserves existing instructions and ignore rules", async () => {
    const root = await makeProject({
      ".gitignore": "node_modules/\ndist/\n",
      "AGENTS.md": "# House rules\n\nRun the tests.\n",
      "CLAUDE.md": "@AGENTS.md\n",
    });

    await planAndApply(root, ["--claude"]);

    const ignoreRules = await Bun.file(`${root}/.gitignore`).text();
    expect(ignoreRules.startsWith("node_modules/\ndist/\n")).toBe(true);
    expect(ignoreRules).toContain("/.operator/");
    const instructions = await Bun.file(`${root}/AGENTS.md`).text();
    expect(instructions.startsWith("# House rules\n\nRun the tests.\n")).toBe(true);
    expect(instructions).toContain("<!-- operator:instructions -->");
  });

  test("does not import AGENTS.md twice", async () => {
    const root = await makeProject({ "CLAUDE.md": "# Project\n\n@AGENTS.md\n" });

    const plan = await runJson(root, ["setup", "plan", "--claude"]);

    expect(plan.json.data.changes.map((change: { path: string }) => change.path)).not.toContain(
      "CLAUDE.md",
    );
  });

  test("reports an invalid existing configuration instead of replacing it", async () => {
    const root = await makeProject({ ".operator/config.json": '{"operatr":{}}' });

    const result = await runJson(root, ["setup", "plan", "--claude"]);

    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({
      outcome: "conflict",
      reason: "setup_conflict",
      blockers: [{ reason: "invalid_configuration", path: ".operator/config.json" }],
    });
    expect(await Bun.file(`${root}/.operator/config.json`).text()).toBe('{"operatr":{}}');
    expect(await filesUnder(root)).toEqual([".operator/config.json"]);
  });

  test("reports a changed Operator instruction section instead of rewriting it", async () => {
    const root = await makeProject();
    await planAndApply(root, ["--opencode"]);
    const instructions = await Bun.file(`${root}/AGENTS.md`).text();
    await Bun.write(
      `${root}/AGENTS.md`,
      instructions.replace("## Operator", "## Operator (my wording)"),
    );

    const result = await runJson(root, ["setup", "plan", "--opencode"]);

    expect(result.exitCode).toBe(4);
    expect(result.json.blockers).toEqual([
      expect.objectContaining({ reason: "instructions_modified", path: "AGENTS.md" }),
    ]);
  });

  test("reports tracked Operator files without changing the Git index", async () => {
    const root = await makeProject({ ".operator/config.json": "{}" });
    await Bun.$`git init -q`.cwd(root).quiet();
    await Bun.$`git add .operator/config.json`.cwd(root).quiet();

    const result = await runJson(root, ["setup", "plan", "--opencode"]);

    expect(result.exitCode).toBe(4);
    expect(result.json.blockers).toEqual([
      expect.objectContaining({
        reason: "operator_directory_tracked",
        paths: [".operator/config.json"],
      }),
    ]);
    const staged = await Bun.$`git diff --cached --name-only`.cwd(root).quiet().text();
    expect(staged.trim()).toBe(".operator/config.json");
  });

  test("stages nothing when it applies a plan in a Git repository", async () => {
    const root = await makeProject();
    await Bun.$`git init -q`.cwd(root).quiet();

    await planAndApply(root, ["--claude"]);

    const staged = await Bun.$`git diff --cached --name-only`.cwd(root).quiet().text();
    expect(staged).toBe("");
  });
});

describe("operator setup plan", () => {
  test("reports a changed skill copy without touching it", async () => {
    const root = await makeProject();
    await runOperator(root, ["install", "--claude"]);
    await Bun.write(`${root}/.claude/skills/operator/SKILL.md`, "# my own edit\n");

    const result = await runJson(root, ["setup", "plan", "--claude"]);

    expect(result.exitCode).toBe(4);
    expect(result.json.blockers).toEqual([
      expect.objectContaining({
        reason: "skill_copy_modified",
        paths: [".claude/skills/operator/SKILL.md"],
      }),
    ]);
    expect(await Bun.file(`${root}/.claude/skills/operator/SKILL.md`).text()).toBe(
      "# my own edit\n",
    );
  });

  test("answers a bare subcommand with a machine-readable result", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup"]);

    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ outcome: "invalid", reason: "invalid_arguments" });
  });
});

describe("operator setup rollback", () => {
  test("refuses a second apply while a recovery record is pending", async () => {
    const root = await makeProject({ ".gitignore": "node_modules/\n" });
    await Bun.$`mkdir -p ${root}/CLAUDE.md`.quiet();
    await planAndApply(root, ["--claude"]);
    const journalBefore = await Bun.file(`${root}/.operator/local/setup-journal.json`).text();

    const result = await planAndApply(root, ["--opencode"]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("setup_interrupted");
    expect(await Bun.file(`${root}/.operator/local/setup-journal.json`).text()).toBe(journalBefore);
  });

  test("reports nothing to restore in an untouched project", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "rollback"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("nothing_to_restore");
  });

  test("restores the writes of an interrupted setup", async () => {
    // A directory at CLAUDE.md fails the last write, so setup stops with the plan incomplete.
    const root = await makeProject({ ".gitignore": "node_modules/\n" });
    await Bun.$`mkdir -p ${root}/CLAUDE.md`.quiet();

    const applied = await planAndApply(root, ["--claude"]);
    expect(applied.exitCode).toBe(1);
    expect(applied.json.reason).toBe("setup_interrupted");
    expect(await Bun.file(`${root}/.gitignore`).text()).toContain("/.operator/");

    const result = await runJson(root, ["setup", "rollback"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("restored");
    expect(await Bun.file(`${root}/.gitignore`).text()).toBe("node_modules/\n");
    expect(await Bun.file(`${root}/AGENTS.md`).exists()).toBe(false);
    expect(await Bun.file(`${root}/.operator/config.json`).exists()).toBe(false);
  });

  test("preserves a later user edit and reports it as a conflict", async () => {
    const root = await makeProject({ ".gitignore": "node_modules/\n" });
    await Bun.$`mkdir -p ${root}/CLAUDE.md`.quiet();
    await planAndApply(root, ["--claude"]);
    await Bun.write(`${root}/.gitignore`, "node_modules/\n/.operator/\nmy-own-rule\n");

    const result = await runJson(root, ["setup", "rollback"]);

    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({
      outcome: "conflict",
      reason: "restore_conflict",
      blockers: [{ reason: "restore_conflict", path: ".gitignore" }],
    });
    expect(await Bun.file(`${root}/.gitignore`).text()).toBe(
      "node_modules/\n/.operator/\nmy-own-rule\n",
    );
    expect(await Bun.file(`${root}/AGENTS.md`).exists()).toBe(false);
  });

  test("restores nothing twice", async () => {
    const root = await makeProject();
    await Bun.$`mkdir -p ${root}/CLAUDE.md`.quiet();
    await planAndApply(root, ["--claude"]);
    await runJson(root, ["setup", "rollback"]);

    const result = await runJson(root, ["setup", "rollback"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("nothing_to_restore");
  });

  test("reports a completed setup as nothing to roll back", async () => {
    const root = await makeProject();
    await planAndApply(root, ["--opencode"]);

    const result = await runJson(root, ["setup", "rollback"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("setup_complete");
  });
});
