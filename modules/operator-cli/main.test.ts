import { describe, expect, test } from "bun:test";

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
});
