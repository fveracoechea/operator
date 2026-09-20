import { describe, expect, test } from "bun:test";
// Bun has no recursive directory copy or removal API, or symbolic link creation API.
import { cp, rm, symlink } from "node:fs/promises";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function runOperator(args: string[], cwd = repositoryRoot) {
  const process = Bun.spawn(["bun", `${repositoryRoot}/cli.ts`, ...args], {
    cwd,
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

async function runImportedOperator(args: string[]) {
  const process = Bun.spawn(
    [
      "bun",
      "--no-install",
      "-e",
      'import { main } from "@fveracoechea/operator/cli"; await main(Bun.argv.slice(1));',
      "--",
      ...args,
    ],
    {
      cwd: repositoryRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);

  return { exitCode, stderr, stdout };
}

describe("Operator CLI", () => {
  test("reports the Operator release for a human", async () => {
    const result = await runOperator(["--version"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "operator 0.0.0\n",
    });
  });

  test("reports versioned JSON without diagnostics", async () => {
    const result = await runOperator(["--version", "--json"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        schemaVersion: 1,
        outcome: "completed",
        reason: "version_reported",
        blockers: [],
        operation: "version",
        data: {
          operatorVersion: "0.0.0",
          bunVersion: Bun.version,
        },
      })}\n`,
    });
  });

  test("propagates arguments through the importable entry point", async () => {
    const result = await runImportedOperator(["--json", "--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: {
        operatorVersion: "0.0.0",
        bunVersion: Bun.version,
      },
    });
  });

  test("rejects a missing command with human-readable usage", async () => {
    const result = await runOperator([]);

    expect(result).toEqual({
      exitCode: 2,
      stderr: "Usage: operator --version [--json]\n",
      stdout: "",
    });
  });

  test("keeps JSON output machine-readable when arguments are invalid", async () => {
    const result = await runOperator(["unknown", "--json"]);

    expect(result).toEqual({
      exitCode: 2,
      stderr: "Usage: operator --version [--json]\n",
      stdout: `${JSON.stringify({
        schemaVersion: 1,
        outcome: "invalid",
        reason: "invalid_arguments",
        blockers: [],
        operation: "parse_arguments",
      })}\n`,
    });
  });

  test("requires an explicit install target without writing to the project", async () => {
    const project = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${project}`.quiet();

    try {
      const process = Bun.spawn(["bun", `${repositoryRoot}/cli.ts`, "install", "--json"], {
        cwd: project,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
        new Response(process.stdout).text(),
      ]);

      expect(exitCode).toBe(2);
      expect(stderr).toBe("operator install: pass --opencode, --claude, or both.\n");
      expect(JSON.parse(stdout)).toEqual({
        schemaVersion: 1,
        outcome: "invalid",
        reason: "install_target_required",
        blockers: [],
        operation: "install",
      });
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: project, dot: true }))).toEqual(
        [],
      );
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("installs the complete Operator skill into one explicit target", async () => {
    const project = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${project}`.quiet();

    try {
      const process = Bun.spawn(
        ["bun", `${repositoryRoot}/cli.ts`, "install", "--opencode", "--json"],
        {
          cwd: project,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
        new Response(process.stdout).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        schemaVersion: 1,
        outcome: "completed",
        reason: "skills_installed",
        blockers: [],
        operation: "install",
        data: {
          targets: ["opencode"],
          changed: [".agents/skills/operator"],
        },
      });

      const sourceFiles = await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: `${repositoryRoot}/skills/operator`, dot: true }),
      );
      const installedFiles = await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: `${project}/.agents/skills/operator`, dot: true }),
      );
      expect(installedFiles.toSorted()).toEqual(sourceFiles.toSorted());
      for (const path of sourceFiles) {
        expect(await Bun.file(`${project}/.agents/skills/operator/${path}`).text()).toBe(
          await Bun.file(`${repositoryRoot}/skills/operator/${path}`).text(),
        );
      }
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("installs matching skill copies into both explicit targets", async () => {
    const project = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${project}`.quiet();

    try {
      const process = Bun.spawn(
        ["bun", `${repositoryRoot}/cli.ts`, "install", "--opencode", "--claude", "--json"],
        { cwd: project, stderr: "pipe", stdout: "pipe" },
      );
      const [exitCode, stdout] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        outcome: "completed",
        reason: "skills_installed",
        data: {
          targets: ["opencode", "claude"],
          changed: [".agents/skills/operator", ".claude/skills/operator"],
        },
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(true);
      expect(await Bun.file(`${project}/.claude/skills/operator/SKILL.md`).exists()).toBe(true);
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("adopts matching copies and rejects a modified copy before writing another target", async () => {
    const project = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${project}/.claude/skills`.quiet();
    await cp(`${repositoryRoot}/skills/operator`, `${project}/.claude/skills/operator`, {
      recursive: true,
    });

    try {
      const matching = await runOperator(["install", "--claude", "--json"], project);
      expect(matching.exitCode).toBe(0);
      expect(JSON.parse(matching.stdout)).toMatchObject({
        outcome: "completed",
        reason: "skills_already_installed",
        data: { changed: [] },
      });

      await Bun.write(`${project}/.claude/skills/operator/SKILL.md`, "user modification\n");
      const conflict = await runOperator(["install", "--opencode", "--claude", "--json"], project);
      expect(conflict.exitCode).toBe(4);
      expect(JSON.parse(conflict.stdout)).toEqual({
        schemaVersion: 1,
        outcome: "conflict",
        reason: "skill_copy_conflict",
        blockers: [
          {
            reason: "skill_copy_conflict",
            path: ".claude/skills/operator",
            target: "claude",
          },
        ],
        operation: "install",
      });
      expect(await Bun.file(`${project}/.agents/skills/operator/SKILL.md`).exists()).toBe(false);
      expect(await Bun.file(`${project}/.claude/skills/operator/SKILL.md`).text()).toBe(
        "user modification\n",
      );
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  });

  test("rejects a symlinked skill copy", async () => {
    const project = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
    const external = `${Bun.env.TMPDIR ?? "/tmp"}/operator-skill-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${project}/.agents/skills`.quiet();
    await cp(`${repositoryRoot}/skills/operator`, external, { recursive: true });
    await symlink(external, `${project}/.agents/skills/operator`);

    try {
      const result = await runOperator(["install", "--opencode", "--json"], project);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "skill_copy_conflict",
        blockers: [
          {
            reason: "skill_copy_conflict",
            path: ".agents/skills/operator",
          },
        ],
      });
      expect(await Bun.file(`${external}/SKILL.md`).text()).toBe(
        await Bun.file(`${repositoryRoot}/skills/operator/SKILL.md`).text(),
      );
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(external, { force: true, recursive: true }),
      ]);
    }
  });

  test("does not install through a symlinked target parent", async () => {
    const project = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
    const external = `${Bun.env.TMPDIR ?? "/tmp"}/operator-skills-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${project} ${external}`.quiet();
    await symlink(external, `${project}/.agents`);

    try {
      const result = await runOperator(["install", "--opencode", "--json"], project);

      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "conflict",
        reason: "skill_copy_conflict",
      });
      expect(await Bun.file(`${external}/skills/operator/SKILL.md`).exists()).toBe(false);
    } finally {
      await Promise.all([
        rm(project, { force: true, recursive: true }),
        rm(external, { force: true, recursive: true }),
      ]);
    }
  });
});
