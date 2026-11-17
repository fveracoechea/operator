import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { invalidArguments, runUsage, workflowArguments } from "./usage.ts";
import { withOutputContext } from "./output.ts";

const release = { version: "9.9.9", commit: "abc", artifactIdentity: "sha256:1" };

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test("plain worker help and version through the isolated CLI seam", async () => {
  const root = Bun.fileURLToPath(new URL("../../../", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      `${root}/tools/test-watchdog.ts`,
      `${root}/src/modules/operator-cli/run.worker-phases.test.ts`,
      "--test-name-pattern",
      "plain version and help retain",
    ],
    {
      cwd: root,
      env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("1 pass");
}, 120000);

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
  expect(usage).toHaveLength(54);
  expect(usage).toContain("       operator abandon --source id --assignment key [--json]");
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
  invalidArguments(json, []);
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
            blockers: [
              { reason: "invalid_arguments", detail: "The command arguments are not supported." },
            ],
            next: { command: "operator --help", why: "Read the supported command syntax." },
          },
        ]
      : [],
  );
  expect(output.error.mock.calls.map(([line]) => String(line))).toEqual([
    "operator: invalid_arguments: The command arguments are not supported.",
    "next: operator --help",
  ]);
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
    operation: "parse_arguments",
    kind: "research",
    phase: "investigate",
    next: { command: "operator --help", why: "Read the supported command syntax." },
  });
  expect(output.log).toHaveBeenCalledTimes(2);
  expect(output.error.mock.calls.map((call) => String(call[0]))).toEqual([
    "operator: invalid_arguments: The command arguments are not supported. [kind=research phase=investigate]",
    "next: operator --help",
  ]);
  expect(process.exitCode).toBe(2);
});

test.each([true, false])("workflow syntax errors name help in two lines, json %p", (json) => {
  const output = capture();
  invalidArguments(json, ["dispatch"]);
  expect(output.error.mock.calls.map(([line]) => String(line))).toEqual([
    "operator: invalid_arguments: The command arguments are not supported.",
    "next: operator --help",
  ]);
  if (json)
    expect(JSON.parse(String(output.log.mock.calls[0]?.[0]))).toMatchObject({
      reason: "invalid_arguments",
      operation: "parse_arguments",
      next: { command: "operator --help", why: "Read the supported command syntax." },
    });
  expect(process.exitCode).toBe(2);
});

test.each([
  [["dispatch"], true],
  [["source"], true],
  [["next"], true],
  [["report"], true],
  [["question"], true],
  [["message"], true],
  [["obligation"], true],
  [["cleanup"], true],
  [["internal-review", "skip"], true],
  [["internal-review", "round"], false],
  [["pr", "skip"], false],
  [["pr", "associate"], false],
  [["unknown", "skip"], false],
  [[], false],
  [[""], false],
] as const)("workflow argument classification for %j is %p", (args, expected) => {
  expect(workflowArguments([...args])).toBe(expected);
});
