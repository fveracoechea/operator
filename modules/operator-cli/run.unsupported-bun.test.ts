import { expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import packageJson from "../../package.json" with { type: "json" };

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const unsupportedBunVersion = "1.3.13";
const bunExecutable = Bun.argv[0];

if (!bunExecutable) {
  throw new Error("Bun did not report its executable path");
}

test.skipIf(Bun.version !== unsupportedBunVersion)(
  "rejects an unsupported Bun before changing the working directory",
  async () => {
    const workingDirectory = `${Bun.env.TMPDIR ?? "/tmp"}/operator-unsupported-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${workingDirectory}`.quiet();

    try {
      const child = Bun.spawn([bunExecutable, cliPath, "--version"], {
        cwd: workingDirectory,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);

      expect({ exitCode, stderr, stdout }).toEqual({
        exitCode: 1,
        stderr: `operator: Bun ${packageJson.engines.bun} is required; running ${unsupportedBunVersion}.\n`,
        stdout: "",
      });
      expect(
        await Array.fromAsync(
          new Bun.Glob("*").scan({ cwd: workingDirectory, dot: true, onlyFiles: false }),
        ),
      ).toEqual([]);
    } finally {
      await rm(workingDirectory, { force: true, recursive: true });
    }
  },
);

test.skipIf(Bun.version !== unsupportedBunVersion)(
  "returns one JSON result when Bun is unsupported",
  async () => {
    const child = Bun.spawn([bunExecutable, cliPath, "--version", "--json"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `operator: Bun ${packageJson.engines.bun} is required; running ${unsupportedBunVersion}.\n`,
    );
    expect(JSON.parse(stdout)).toEqual({
      schemaVersion: 1,
      outcome: "failed",
      reason: "unsupported_bun",
      blockers: [
        {
          reason: "unsupported_bun",
          required: packageJson.engines.bun,
          actual: unsupportedBunVersion,
        },
      ],
      operation: "startup",
      data: {
        operatorVersion: "0.0.0",
        bunVersion: unsupportedBunVersion,
      },
    });
  },
);
