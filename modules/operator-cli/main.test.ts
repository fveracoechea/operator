import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { mkdir, rm } from "node:fs/promises";
import packageJson from "../../package.json" with { type: "json" };
import { usage } from "./operations.ts";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
// The CLI runs outside any project, so no local release selection reaches it. This file makes the
// directory itself, because no other test file is sure to run first in the same shard.
const outsideProject = `${Bun.env.TMPDIR ?? "/tmp"}/operator-cli-main-${crypto.randomUUID()}`;

beforeAll(async () => {
  await mkdir(outsideProject, { recursive: true });
});

afterAll(async () => {
  await rm(outsideProject, { force: true, recursive: true });
});

async function runOperator(args: string[]) {
  const child = Bun.spawn([process.execPath, `${repositoryRoot}cli.ts`, ...args], {
    cwd: outsideProject,
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

async function runImportedOperator(args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
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
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);

  return { exitCode, stderr, stdout };
}

describe("Operator CLI", () => {
  test("reports the Operator release for a human", async () => {
    const result = await runOperator(["--version"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `operator ${packageJson.version}\n`,
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
          operatorVersion: packageJson.version,
          bunVersion: Bun.version,
          selection: { state: "missing" },
        },
      })}\n`,
    });
  });

  test("propagates arguments through the importable entry point", async () => {
    const result = await runImportedOperator(["--json", "--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // The repository root may hold a release selection of its own, so only the versions are fixed.
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: {
        operatorVersion: packageJson.version,
        bunVersion: Bun.version,
      },
    });
  });

  test("rejects a missing command with human-readable usage", async () => {
    const result = await runOperator([]);

    expect(result).toEqual({
      exitCode: 2,
      stderr: `${usage}\n`,
      stdout: "",
    });
  });

  test("keeps JSON output machine-readable when arguments are invalid", async () => {
    const result = await runOperator(["unknown", "--json"]);

    expect(result).toEqual({
      exitCode: 2,
      stderr: `${usage}\n`,
      stdout: `${JSON.stringify({
        schemaVersion: 1,
        outcome: "invalid",
        reason: "invalid_arguments",
        blockers: [],
        operation: "parse_arguments",
      })}\n`,
    });
  });

  const unsupportedRequests = [
    ["install", "--claude", "--operator-host", "claude-code"],
    ["setup", "plan", "--claude", "--crew-model", "sonnet"],
    ["setup", "rollback", "--operator-host", "opencode"],
    ["setup", "readiness", "--claude", "--approved-plan", "abc"],
    ["setup", "readiness", "--claude", "--operator-host", "cursor"],
    ["setup", "readiness", "--claude", "--operator-host"],
    ["setup", "probe", "--claude"],
    ["setup", "probe", "wibble", "--claude"],
    ["setup", "probe", "plan", "--claude", "--approved-probe", "abc"],
    ["setup", "probe", "apply", "--claude", "--approved-plan", "abc"],
    // A flag the operation does not name.
    ["work", "frontier", "--source", "source-1"],
    ["publish", "plan", "--source", "source-1", "--request", "request-1"],
    ["crew", "next", "--claude", "--request", "request-1"],
    // A missing required flag.
    ["publish", "apply", "--source", "source-1", "--plan-revision", "revision-1"],
    ["gate", "show"],
    // A value rule of the operation.
    ["install", "matt", "apply", "--claude", "--commit", "abc", "--approved-plan", "plan-1"],
    ["install", "matt", "apply", "--commit", "abc"],
    ["wake", "check", "--root", ""],
    ["wake", "arm", "--owner-label", "operator"],
    // A host that is not one of the choices.
    ["wake", "arm", "--owner-label", "operator", "--claude", "--operator-host", "bogus"],
  ];

  for (const args of unsupportedRequests) {
    test(`refuses \`operator ${args.join(" ")}\``, async () => {
      const result = await runOperator([...args, "--json"]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).reason).toBe("invalid_arguments");
    });
  }

  test("refuses an operation with no target before its handler runs", async () => {
    const result = await runOperator([
      "install",
      "matt",
      "apply",
      "--commit",
      "a".repeat(40),
      "--json",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(`${usage}\n`);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      outcome: "invalid",
      reason: "missing_target",
      blockers: [{ reason: "missing_target", required: ["--opencode", "--claude"] }],
      operation: "install_matt_apply",
    });
  });

  test("prints the usage text byte for byte", async () => {
    const result = await runOperator([]);

    expect(result.stderr).toBe(
      await Bun.file(new URL("usage.expected.txt", import.meta.url)).text(),
    );
  });

  test("lists every supported command in its usage", async () => {
    const result = await runOperator([]);

    expect(result.stderr).toContain("operator setup readiness");
    expect(result.stderr).toContain("operator setup probe plan");
    expect(result.stderr).toContain("operator setup probe apply");
  });
});
