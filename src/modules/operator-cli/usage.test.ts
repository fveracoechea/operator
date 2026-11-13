import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { invalidArguments, runUsage } from "./usage.ts";
import { withOutputContext } from "./output.ts";

const release = { version: "9.9.9", commit: "abc", artifactIdentity: "sha256:1" };

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

function capture() {
  process.exitCode = 9;
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function usageText(text: string | undefined) {
  const usage = String(text).split("\n");
  expect(usage[0]).toBe("Usage: operator --help | --version [--json]");
  expect(usage).toHaveLength(55);
}

test.each([
  [["--help"], false],
  [["--help"], true],
] as const)("help %j prints the usage", (args, json) => {
  const output = capture();
  expect(runUsage([...args], release, json)).toBe(true);
  usageText(output.log.mock.calls[0]?.[0] as string | undefined);
  expect(process.exitCode).toBe(0);
});

test("version prints the release version", () => {
  const output = capture();
  expect(runUsage(["--version"], release, false)).toBe(true);
  expect(output.log).toHaveBeenCalledWith("operator 9.9.9");
  expect(process.exitCode).toBe(0);
});

test.each([[["--version", "--json"]], [["--json", "--version"]]])(
  "version %j reports the release as JSON",
  (args) => {
    const output = capture();
    expect(runUsage(args, release, true)).toBe(true);
    expect(JSON.parse(String(output.log.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: 1,
      operation: "version",
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      data: {
        operatorVersion: "9.9.9",
        bunVersion: Bun.version,
        commit: "abc",
        artifactIdentity: "sha256:1",
      },
    });
    expect(process.exitCode).toBe(0);
  },
);

test.each([
  [[], false],
  [["--help", "--json"], true],
  [["--help", "--help"], false],
  [["help"], false],
  [["--version", "--version"], false],
  [["--version", "--json"], false],
  [["--version", "other"], false],
  [["--version", "--json", "x"], true],
  [["ready", "--json"], true],
] as const)("leaves %j to the commands", (args, json) => {
  const output = capture();
  expect(runUsage([...args], release, json)).toBe(false);
  expect(output.log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(9);
});

test.each([true, false])("invalid arguments print the usage, json %p", (json) => {
  const output = capture();
  invalidArguments(json);
  expect(
    output.log.mock.calls.map(([line]) => z.unknown().parse(JSON.parse(String(line)))),
  ).toEqual(
    json
      ? [
          {
            schemaVersion: 1,
            operation: "parse_arguments",
            outcome: "invalid",
            reason: "invalid_arguments",
            blockers: [{ reason: "invalid_arguments" }],
          },
        ]
      : [],
  );
  usageText(output.error.mock.calls[0]?.[0] as string | undefined);
  expect(process.exitCode).toBe(2);
});

test("version and argument refusals preserve a worker's phase and next action", async () => {
  const output = capture();
  await withOutputContext(
    () => ({
      kind: "research",
      phase: "investigate",
      next: { command: "operator report submit --file <file>", why: "Submit." },
    }),
    async () => {
      runUsage(["--version", "--json"], release, true);
      invalidArguments(true);
    },
  );
  expect(JSON.parse(String(output.log.mock.calls[0]?.[0]))).toMatchObject({
    kind: "research",
    phase: "investigate",
    next: { command: "operator report submit --file <file>", why: "Submit." },
  });
  expect(JSON.parse(String(output.log.mock.calls[1]?.[0]))).toMatchObject({
    kind: "research",
    phase: "investigate",
    next: { command: "operator --help", why: "Read the implemented commands and their flags." },
  });
  expect(output.log).toHaveBeenCalledTimes(2);
  expect(output.error.mock.calls.map((call) => String(call[0]))).toEqual([
    "operator: invalid_arguments: The arguments do not name an implemented command. Read operator --help. [kind=research phase=investigate]",
    "next: operator --help",
  ]);
  expect(process.exitCode).toBe(2);
});
