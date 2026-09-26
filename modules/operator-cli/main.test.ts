import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { usage } from "./usage.ts";

const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function runOperator(args: string[]) {
  const process = Bun.spawn(["bun", "cli.ts", ...args], {
    cwd: repositoryRoot,
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
  ];

  for (const args of unsupportedRequests) {
    test(`refuses \`operator ${args.join(" ")}\``, async () => {
      const result = await runOperator([...args, "--json"]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout).reason).toBe("invalid_arguments");
    });
  }

  test("lists every supported command in its usage", async () => {
    const result = await runOperator([]);

    expect(result.stderr).toContain("operator setup readiness");
    expect(result.stderr).toContain("operator setup probe plan");
    expect(result.stderr).toContain("operator setup probe apply");
  });
});
