import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm, symlink } from "node:fs/promises";

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

async function runOperator(root: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
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

async function runJson(root: string, args: string[], env: Record<string, string> = {}) {
  const result = await runOperator(root, [...args, "--json"], env);
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

/**
 * A PATH whose git fails `ls-files`: `term` ends it on SIGTERM, as a timeout does, and `exit` ends
 * it with exit 3. With `missing`, the PATH holds only bun, so git is not on it.
 */
async function gitPath(root: string, fault: "term" | "exit" | "missing"): Promise<string> {
  const bin = `${root}-bin`;
  projectRoots.push(bin);
  await Bun.$`mkdir -p ${bin}`.quiet();
  if (fault === "missing") {
    await symlink(process.execPath, `${bin}/bun`);
    return bin;
  }
  await Bun.write(
    `${bin}/git`,
    [
      "#!/bin/sh",
      // The guard of ADR 0018 and `-C <repo>` come before the subcommand.
      'if [ "$6" = "ls-files" ]; then',
      fault === "term" ? "  kill -TERM $$" : "  exit 3",
      "fi",
      `exec ${Bun.which("git")} "$@"`,
      "",
    ].join("\n"),
  );
  await Bun.$`chmod +x ${bin}/git`.quiet();
  return `${bin}:${process.env.PATH ?? ""}`;
}

describe("operator setup plan with a Git that fails", () => {
  const unavailable = (reason: string) =>
    `Setup cannot read the Git index, so it cannot check for tracked Operator files: ${reason}. Install Git yourself, then plan again.`;

  // A named departure of #153: the detail names the missing git as every other Git reader does,
  // not the Bun spawn error.
  test("names a git that is not on the path", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "plan", "--claude"], {
      PATH: await gitPath(root, "missing"),
    });

    expect(result.json).toMatchObject({ outcome: "conflict", reason: "setup_conflict" });
    expect(result.json.blockers).toEqual([
      {
        reason: "git_unavailable",
        detail: unavailable("git is not on the path, so nothing was requested"),
      },
    ]);
  });

  test("names a git ls-files that ended with no answer", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "plan", "--claude"], {
      PATH: await gitPath(root, "term"),
    });

    expect(result.json.blockers).toEqual([
      {
        reason: "git_unavailable",
        detail: unavailable("git ls-files ended on SIGTERM with no answer"),
      },
    ]);
  });

  test("reads a git ls-files exit as a project with no index", async () => {
    const root = await makeProject();

    const result = await runJson(root, ["setup", "plan", "--claude"], {
      PATH: await gitPath(root, "exit"),
    });

    expect(result.json).toMatchObject({ outcome: "completed", reason: "plan_ready", blockers: [] });
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
    expect(result.stdout).toStartWith(
      `{"schemaVersion":1,"outcome":"missing-condition","reason":"approval_required","blockers":[{"reason":"approval_required","currentPlanId":"${result.json.data.planId}","approvedPlanId":null}],"operation":"setup_apply","data":{"planId":`,
    );
    const plan = await runOperator(root, ["setup", "plan", "--claude"]);
    const text = await runOperator(root, ["setup", "apply", "--claude"]);
    expect(text.stdout).toBe(`Setup needs an approved plan. Nothing was written.\n${plan.stdout}`);
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
    expect(result.stdout).toStartWith(
      `{"schemaVersion":1,"outcome":"missing-condition","reason":"approval_stale","blockers":[{"reason":"approval_stale","currentPlanId":"${result.json.data.planId}","approvedPlanId":"${"0".repeat(64)}"}],"operation":"setup_apply","data":{"planId":`,
    );
    const plan = await runOperator(root, ["setup", "plan", "--claude"]);
    const text = await runOperator(root, [
      "setup",
      "apply",
      "--claude",
      "--approved-plan",
      "0".repeat(64),
    ]);
    expect(text.stdout).toBe(
      `The approved plan no longer matches this project or these targets. Nothing was written.\n${plan.stdout}`,
    );
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

  test("replaces the section of an earlier release only under an approved plan", async () => {
    // The exact section that Operator 0.1.0 to 0.6.0 wrote.
    const earlier = [
      "<!-- operator:instructions -->",
      "## Operator",
      "",
      "This project is coordinated with Operator.",
      "Load the `operator` skill before you delegate work, change the crew configuration, or run a setup operation.",
      "Operator configuration lives in `.operator/config.json`, which is local to this checkout and is not committed.",
      "<!-- /operator:instructions -->",
    ].join("\n");
    const root = await makeProject();
    await planAndApply(root, ["--opencode"]);
    await Bun.write(`${root}/AGENTS.md`, `# House rules\n\n${earlier}\n\nRun the tests.\n`);

    const plan = await runJson(root, ["setup", "plan", "--opencode"]);

    expect(plan.exitCode).toBe(0);
    expect(plan.json.data.changes).toEqual([
      expect.objectContaining({ path: "AGENTS.md", kind: "replace" }),
    ]);
    expect(await Bun.file(`${root}/AGENTS.md`).text()).toContain(earlier);

    const applied = await runJson(root, [
      "setup",
      "apply",
      "--opencode",
      "--approved-plan",
      plan.json.data.planId,
    ]);
    const instructions = await Bun.file(`${root}/AGENTS.md`).text();

    expect(applied.json.reason).toBe("setup_applied");
    expect(instructions).not.toContain(earlier);
    expect(instructions.startsWith("# House rules\n\n<!-- operator:instructions -->")).toBe(true);
    expect(instructions.endsWith("<!-- /operator:instructions -->\n\nRun the tests.\n")).toBe(true);
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

  test("refuses apply and rollback while the recovery record cannot be read", async () => {
    const root = await makeProject({ ".operator/local/setup-journal.json": "{ not json" });

    const applied = await planAndApply(root, ["--opencode"]);
    const rolledBack = await runJson(root, ["setup", "rollback"]);

    for (const result of [applied, rolledBack]) {
      expect(result.exitCode).toBe(4);
      expect(result.json).toMatchObject({ outcome: "conflict", reason: "unreadable_journal" });
    }
    expect(await filesUnder(root)).toEqual([".operator/local/setup-journal.json"]);
  });

  test("reports a completed setup as nothing to roll back", async () => {
    const root = await makeProject();
    await planAndApply(root, ["--opencode"]);

    const result = await runJson(root, ["setup", "rollback"]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("setup_complete");
  });
});

describe("what an installed project tells an agent", () => {
  // The files Operator owns. An agent reads and changes them only through CLI commands, so no
  // installed instruction names one: the selection, the configuration, the readiness evidence,
  // the control reference, the setup journal, and the crew database.
  const ownedFiles =
    /(?<![\w-])(?:selection\.json|config\.json|readiness\.json|attempt\.json|setup-journal\.json|crew-state\.sqlite)/g;

  async function installedProject(): Promise<string> {
    const root = await makeProject();
    await runOperator(root, ["install", "--opencode", "--claude"]);
    await planAndApply(root, ["--opencode", "--claude"]);
    return root;
  }

  test("names no Operator-owned file in an installed skill or the instruction section", async () => {
    const root = await installedProject();
    const read = (await filesUnder(root)).filter(
      (path) => path === "AGENTS.md" || /^\.(?:agents|claude)\/skills\/.*\.md$/.test(path),
    );

    const named = (
      await Promise.all(
        read.map(async (path) =>
          [...(await Bun.file(`${root}/${path}`).text()).matchAll(ownedFiles)].map(
            (match) => `${path}: ${match[0]}`,
          ),
        ),
      )
    ).flat();

    expect(read).toContain("AGENTS.md");
    expect(read).toContain(".claude/skills/operator/SKILL.md");
    expect(read).toContain(".agents/skills/operative/SKILL.md");
    expect(named).toEqual([]);
  });

  test("states the CLI rule and the command that reports the selected release", async () => {
    const root = await installedProject();
    const instructions = await Bun.file(`${root}/AGENTS.md`).text();
    const operatorSkill = await Bun.file(`${root}/.claude/skills/operator/SKILL.md`).text();

    expect(instructions).toContain(
      "Read and change all other Operator configuration and state through Operator CLI commands",
    );
    expect(instructions).toContain("JSON requests for the `--input`");
    expect(operatorSkill).toContain(
      "Read and change Operator configuration and state only through CLI commands.",
    );
    expect(operatorSkill).toContain("bun run operator --version --json");
  });
});
