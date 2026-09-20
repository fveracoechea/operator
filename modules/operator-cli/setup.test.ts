import { describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API, permission API, or symbolic link creation API.
import { chmod, rm, symlink } from "node:fs/promises";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function createProject(): Promise<string> {
  const project = `${Bun.env.TMPDIR ?? "/tmp"}/operator-setup-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${project}`.quiet();
  await Bun.$`git init --quiet ${project}`;
  await Bun.write(`${project}/.gitignore`, "dist/\n");
  await Bun.write(`${project}/AGENTS.md`, "# Project instructions\n");
  return project;
}

async function runOperator(project: string, args: string[]) {
  const process = Bun.spawn(["bun", `${repositoryRoot}/cli.ts`, ...args], {
    cwd: project,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("Operator setup", () => {
  test("inspects exact setup changes without writing to the project", async () => {
    const project = await createProject();

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout);
      const changes = output.data.plan.changes;
      expect(changes.map((change: { path: string }) => change.path)).toEqual([
        ".agents/skills/operator/SKILL.md",
        ".agents/skills/operator/setup.md",
        ".gitignore",
        ".operator/config.json",
        ".operator/config.schema.json",
        "AGENTS.md",
      ]);
      expect(output).toMatchObject({
        schemaVersion: 1,
        outcome: "missing-condition",
        reason: "setup_approval_required",
        blockers: [{ reason: "setup_approval_required" }],
        operation: "setup",
        data: {
          targets: ["opencode"],
          plan: {
            id: expect.any(String),
            recovery: {
              path: ".operator/local/setup-recovery.json",
              lifecycle: "created during apply and removed after completion",
            },
          },
        },
      });
      expect(changes.find((change: { path: string }) => change.path === ".gitignore")).toEqual({
        action: "update",
        path: ".gitignore",
        previousHash: expect.any(String),
        content: "dist/\n/.operator/\n",
      });
      expect(
        changes.find((change: { path: string }) => change.path === ".operator/config.json"),
      ).toEqual({
        action: "create",
        path: ".operator/config.json",
        previousHash: null,
        content: '{\n  "$schema": "./config.schema.json"\n}\n',
      });
      const schemaChange = changes.find(
        (change: { path: string }) => change.path === ".operator/config.schema.json",
      );
      expect(
        await Bun.file(`${repositoryRoot}/schemas/generated/config.schema.json`).json(),
      ).toEqual(JSON.parse(schemaChange.content));

      expect(await Bun.file(`${project}/.gitignore`).text()).toBe("dist/\n");
      expect(await Bun.file(`${project}/AGENTS.md`).text()).toBe("# Project instructions\n");
      expect(await Bun.file(`${project}/.operator/config.json`).exists()).toBe(false);
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("prints exact proposed file contents for human approval", async () => {
    const project = await createProject();

    try {
      const result = await runOperator(project, ["setup", "--opencode"]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('create .operator/config.json\n{\n  "$schema":');
      expect(result.stdout).toContain("update .gitignore\ndist/\n/.operator/\n");
      expect(result.stdout).toContain("Approve this unchanged plan with --approve ");
      expect(await Bun.file(`${project}/.operator/config.json`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("applies only the approved unchanged plan and leaves Git staging untouched", async () => {
    const project = await createProject();

    try {
      const inspection = await runOperator(project, ["setup", "--opencode", "--json"]);
      const planId = JSON.parse(inspection.stdout).data.plan.id;
      const application = await runOperator(project, [
        "setup",
        "--opencode",
        "--approve",
        planId,
        "--json",
      ]);

      expect(application.exitCode).toBe(0);
      expect(application.stderr).toBe("");
      expect(JSON.parse(application.stdout)).toEqual({
        schemaVersion: 1,
        outcome: "completed",
        reason: "setup_applied",
        blockers: [],
        operation: "setup",
        data: {
          targets: ["opencode"],
          planId,
          changed: [
            ".agents/skills/operator/SKILL.md",
            ".agents/skills/operator/setup.md",
            ".gitignore",
            ".operator/config.json",
            ".operator/config.schema.json",
            "AGENTS.md",
          ],
        },
      });
      expect(await Bun.file(`${project}/.operator/config.json`).json()).toEqual({
        $schema: "./config.schema.json",
      });
      expect(await Bun.file(`${project}/.operator/config.schema.json`).json()).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).text()).toBe(
        await Bun.file(`${repositoryRoot}/skills/operator/SKILL.md`).text(),
      );
      expect((await Bun.$`git -C ${project} diff --cached --name-only`.text()).trim()).toBe("");

      const modifiedAt = Bun.file(`${project}/.operator/config.json`).lastModified;
      await Bun.sleep(10);
      const rerun = await runOperator(project, ["setup", "--opencode", "--json"]);
      expect(rerun.exitCode).toBe(0);
      expect(JSON.parse(rerun.stdout)).toMatchObject({
        outcome: "completed",
        reason: "setup_configured",
        data: { plan: { changes: [] } },
      });
      expect(Bun.file(`${project}/.operator/config.json`).lastModified).toBe(modifiedAt);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("reports modified skill copies as conflicts without overwriting them", async () => {
    const project = await createProject();
    await Bun.$`mkdir -p ${project}/.agents/skills/operator`.quiet();
    await Bun.write(`${project}/.agents/skills/operator/SKILL.md`, "project-owned instructions\n");

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "skill_copy_conflict",
        blockers: [
          {
            reason: "skill_copy_conflict",
            path: ".agents/skills/operator",
            target: "opencode",
          },
        ],
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).text()).toBe(
        "project-owned instructions\n",
      );
      expect(await Bun.file(`${project}/.operator/config.json`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("rejects unknown configuration fields and preserves the file", async () => {
    const project = await createProject();
    const config = '{\n  "$schema": "./config.schema.json",\n  "review": {}\n}\n';
    await Bun.$`mkdir -p ${project}/.operator`.quiet();
    await Bun.write(`${project}/.operator/config.json`, config);

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "invalid_configuration",
        blockers: [
          {
            reason: "invalid_configuration",
            path: ".operator/config.json",
            issues: expect.any(Array),
          },
        ],
      });
      expect(await Bun.file(`${project}/.operator/config.json`).text()).toBe(config);
      expect(await Bun.file(`${project}/.operator/config.schema.json`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("reports an existing nonmatching generated schema as a conflict", async () => {
    const project = await createProject();
    await Bun.$`mkdir -p ${project}/.operator`.quiet();
    await Bun.write(
      `${project}/.operator/config.json`,
      '{\n  "$schema": "./config.schema.json"\n}\n',
    );
    await Bun.write(`${project}/.operator/config.schema.json`, '{ "project": "schema" }\n');

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "configuration_schema_conflict",
        blockers: [
          {
            reason: "configuration_schema_conflict",
            path: ".operator/config.schema.json",
          },
        ],
      });
      expect(await Bun.file(`${project}/.operator/config.schema.json`).text()).toBe(
        '{ "project": "schema" }\n',
      );
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("refuses tracked Operator state without changing the Git index", async () => {
    const project = await createProject();
    await Bun.$`mkdir -p ${project}/.operator`.quiet();
    await Bun.write(
      `${project}/.operator/config.json`,
      '{\n  "$schema": "./config.schema.json"\n}\n',
    );
    await Bun.$`git -C ${project} add .operator/config.json`.quiet();
    const stagedBefore = await Bun.$`git -C ${project} diff --cached`.text();

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "operator_state_tracked",
        blockers: [
          {
            reason: "operator_state_tracked",
            paths: [".operator/config.json"],
          },
        ],
      });
      expect(await Bun.$`git -C ${project} diff --cached`.text()).toBe(stagedBefore);
      expect(await Bun.file(`${project}/.operator/config.schema.json`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("preserves conflicting existing Operator instructions", async () => {
    const project = await createProject();
    const instructions = "# Project instructions\n\n## Operator\n\nUse the project workflow.\n";
    await Bun.write(`${project}/AGENTS.md`, instructions);

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "instruction_conflict",
        blockers: [
          {
            reason: "instruction_conflict",
            path: "AGENTS.md",
          },
        ],
      });
      expect(await Bun.file(`${project}/AGENTS.md`).text()).toBe(instructions);
      expect(await Bun.file(`${project}/.operator/config.json`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("records an interrupted two-target setup and restores its completed writes", async () => {
    const project = await createProject();
    await Bun.$`mkdir -p ${project}/.claude/skills`.quiet();

    try {
      const inspection = await runOperator(project, ["setup", "--opencode", "--claude", "--json"]);
      const planId = JSON.parse(inspection.stdout).data.plan.id;
      await chmod(`${project}/.claude/skills`, 0o500);

      const application = await runOperator(project, [
        "setup",
        "--opencode",
        "--claude",
        "--approve",
        planId,
        "--json",
      ]);

      expect(application.exitCode).toBe(1);
      expect(application.stderr).toBe("");
      expect(JSON.parse(application.stdout)).toMatchObject({
        outcome: "failed",
        reason: "setup_interrupted",
        blockers: [
          {
            reason: "setup_interrupted",
            path: ".claude/skills/operator/SKILL.md",
          },
        ],
        data: {
          planId,
          recoveryPath: ".operator/local/setup-recovery.json",
          changed: [".agents/skills/operator/SKILL.md", ".agents/skills/operator/setup.md"],
        },
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(true);
      expect(await Bun.file(`${project}/.operator/local/setup-recovery.json`).exists()).toBe(true);

      await chmod(`${project}/.claude/skills`, 0o700);
      const recoveryInspection = await runOperator(project, [
        "setup",
        "--recover",
        planId,
        "--json",
      ]);
      expect(recoveryInspection.exitCode).toBe(3);
      const recoveryPlanId = JSON.parse(recoveryInspection.stdout).data.recoveryPlan.id;
      const recovery = await runOperator(project, [
        "setup",
        "--recover",
        planId,
        "--approve",
        recoveryPlanId,
        "--json",
      ]);
      expect(recovery.exitCode).toBe(0);
      expect(JSON.parse(recovery.stdout)).toMatchObject({
        outcome: "completed",
        reason: "setup_recovered",
        data: {
          planId,
          restored: [".agents/skills/operator/setup.md", ".agents/skills/operator/SKILL.md"],
        },
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(false);
      expect(await Bun.file(`${project}/.operator/local/setup-recovery.json`).exists()).toBe(false);
      expect(await Bun.file(`${project}/.gitignore`).text()).toBe("dist/\n");
      expect(await Bun.file(`${project}/AGENTS.md`).text()).toBe("# Project instructions\n");
    } finally {
      await chmod(`${project}/.claude/skills`, 0o700).catch(() => undefined);
      await rm(project, { force: true, recursive: true });
    }
  });

  test("preserves user edits made after an interrupted setup", async () => {
    const project = await createProject();
    await Bun.$`mkdir -p ${project}/.claude/skills`.quiet();

    try {
      const inspection = await runOperator(project, ["setup", "--opencode", "--claude", "--json"]);
      const planId = JSON.parse(inspection.stdout).data.plan.id;
      await chmod(`${project}/.claude/skills`, 0o500);
      const application = await runOperator(project, [
        "setup",
        "--opencode",
        "--claude",
        "--approve",
        planId,
        "--json",
      ]);
      expect(application.exitCode).toBe(1);

      await Bun.write(`${project}/.agents/skills/operator/SKILL.md`, "later user edit\n");
      await chmod(`${project}/.claude/skills`, 0o700);
      const recoveryInspection = await runOperator(project, [
        "setup",
        "--recover",
        planId,
        "--json",
      ]);
      expect(recoveryInspection.exitCode).toBe(3);
      expect(await Bun.file(`${project}/.agents/skills/operator/setup.md`).exists()).toBe(true);
      const recoveryPlanId = JSON.parse(recoveryInspection.stdout).data.recoveryPlan.id;
      const recovery = await runOperator(project, [
        "setup",
        "--recover",
        planId,
        "--approve",
        recoveryPlanId,
        "--json",
      ]);

      expect(recovery.exitCode).toBe(4);
      expect(JSON.parse(recovery.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "setup_recovery_conflict",
        blockers: [
          {
            reason: "setup_recovery_conflict",
            path: ".agents/skills/operator/SKILL.md",
          },
        ],
        data: {
          planId,
          restored: [".agents/skills/operator/setup.md"],
        },
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).text()).toBe(
        "later user edit\n",
      );
      expect(await Bun.file(`${project}/.agents/skills/operator/setup.md`).exists()).toBe(false);
      expect(await Bun.file(`${project}/.operator/local/setup-recovery.json`).exists()).toBe(true);
    } finally {
      await chmod(`${project}/.claude/skills`, 0o700).catch(() => undefined);
      await rm(project, { force: true, recursive: true });
    }
  });

  test("requires new approval when files or selected targets change", async () => {
    const project = await createProject();

    try {
      const inspection = await runOperator(project, ["setup", "--opencode", "--json"]);
      const planId = JSON.parse(inspection.stdout).data.plan.id;
      await Bun.write(`${project}/.gitignore`, "dist/\ncoverage/\n");

      const changedFile = await runOperator(project, [
        "setup",
        "--opencode",
        "--approve",
        planId,
        "--json",
      ]);
      expect(changedFile.exitCode).toBe(4);
      expect(JSON.parse(changedFile.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "setup_plan_changed",
        blockers: [{ reason: "setup_plan_changed", approvedPlanId: planId }],
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(false);

      const changedTargets = await runOperator(project, [
        "setup",
        "--opencode",
        "--claude",
        "--approve",
        planId,
        "--json",
      ]);
      expect(changedTargets.exitCode).toBe(4);
      expect(JSON.parse(changedTargets.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "setup_plan_changed",
        blockers: [{ reason: "setup_plan_changed", approvedPlanId: planId }],
      });
      expect(await Bun.file(`${project}/.claude/skills/operator/SKILL.md`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("preserves valid selections, ignore rules, and existing instructions", async () => {
    const project = await createProject();
    const config = `${JSON.stringify(
      {
        $schema: "./config.schema.json",
        operator: { host: "opencode", model: "provider/operator-model" },
        crew: { host: "claude" },
      },
      null,
      2,
    )}\n`;
    await Bun.$`mkdir -p ${project}/.operator`.quiet();
    await Bun.write(`${project}/.operator/config.json`, config);
    await Bun.write(`${project}/CLAUDE.md`, "# Claude project instructions\n");

    try {
      const inspection = await runOperator(project, ["setup", "--opencode", "--claude", "--json"]);
      const planId = JSON.parse(inspection.stdout).data.plan.id;
      const application = await runOperator(project, [
        "setup",
        "--opencode",
        "--claude",
        "--approve",
        planId,
        "--json",
      ]);

      expect(application.exitCode).toBe(0);
      expect(await Bun.file(`${project}/.operator/config.json`).text()).toBe(config);
      expect(await Bun.file(`${project}/.gitignore`).text()).toBe("dist/\n/.operator/\n");
      expect(await Bun.file(`${project}/AGENTS.md`).text()).toContain("# Project instructions\n");
      expect(await Bun.file(`${project}/AGENTS.md`).text()).toContain("<!-- operator:start -->");
      expect(await Bun.file(`${project}/CLAUDE.md`).text()).toBe(
        "# Claude project instructions\n@AGENTS.md\n",
      );
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(true);
      expect(await Bun.file(`${project}/.claude/skills/operator/SKILL.md`).exists()).toBe(true);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("blocks setup when an existing recovery record is damaged", async () => {
    const project = await createProject();
    await Bun.$`mkdir -p ${project}/.operator/local`.quiet();
    await Bun.write(`${project}/.operator/local/setup-recovery.json`, "{ damaged\n");

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "setup_recovery_damaged",
        blockers: [
          {
            reason: "setup_recovery_damaged",
            path: ".operator/local/setup-recovery.json",
          },
        ],
      });
      expect(await Bun.file(`${project}/.operator/local/setup-recovery.json`).text()).toBe(
        "{ damaged\n",
      );
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(false);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("rejects symlinked setup paths without writing through them", async () => {
    const project = await createProject();
    const external = `${Bun.env.TMPDIR ?? "/tmp"}/operator-state-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${external}`.quiet();
    await symlink(external, `${project}/.operator`);

    try {
      const result = await runOperator(project, ["setup", "--opencode", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "setup_path_symlink",
        blockers: [
          {
            reason: "setup_path_symlink",
            path: ".operator",
          },
        ],
      });
      expect(
        await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: external, dot: true })),
      ).toEqual([]);
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(external, { force: true, recursive: true }),
      ]);
    }
  });

  test("rejects a recovery record that targets a path outside the project", async () => {
    const project = await createProject();
    const outsideName = `operator-outside-${crypto.randomUUID()}`;
    const outside = `${Bun.env.TMPDIR ?? "/tmp"}/${outsideName}`;
    const setupOutput = "setup output\n";
    const path = `../${outsideName}`;
    const plan = {
      operatorVersion: "0.0.0",
      targets: ["opencode"],
      changes: [{ action: "create", path, previousHash: null, content: setupOutput }],
      blockers: [],
    };
    const planId = new Bun.CryptoHasher("sha256").update(JSON.stringify(plan)).digest("hex");
    const contentHash = new Bun.CryptoHasher("sha256").update(setupOutput).digest("hex");
    await Bun.write(outside, setupOutput);
    await Bun.$`mkdir -p ${project}/.operator/local`.quiet();
    await Bun.write(
      `${project}/.operator/local/setup-recovery.json`,
      `${JSON.stringify({
        schemaVersion: 1,
        planId,
        plan,
        state: "interrupted",
        writes: [
          {
            path,
            previousContent: null,
            contentHash,
            status: "completed",
          },
        ],
      })}\n`,
    );

    try {
      const result = await runOperator(project, ["setup", "--recover", planId, "--json"]);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "setup_recovery_conflict",
      });
      expect(await Bun.file(outside).text()).toBe(setupOutput);
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(outside, { force: true }),
      ]);
    }
  });
});
