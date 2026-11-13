import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no temporary directory or recursive directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { registerTestDevice } from "../../../tools/device-fixture.ts";

const { join } = path;
const versionOutput = z.object({
  reason: z.string(),
  data: z.looseObject({ operatorVersion: z.string() }),
});
const cli = new URL("../../cli.ts", import.meta.url).pathname;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("version reports the running release without project release selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-cli-removal-"));
  roots.push(root);
  const databaseBefore = await registerTestDevice(root);
  const legacy = `${root}/.operator/install/selection.json`;
  await Bun.write(legacy, "do not read or replace this legacy state\n", { createPath: true });
  const child = Bun.spawn([process.execPath, cli, "--version", "--json"], {
    cwd: root,
    env: {
      ...Environment.child(),
      // Runtime caches are not Operator writes and must not enter the effect fixture.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      XDG_CACHE_HOME: undefined,
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).json().then((value) => versionOutput.parse(value)),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(error).toBe("");
  expect(output.reason).toBe("version_reported");
  expect(output.data.operatorVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(output.data).not.toHaveProperty("selection");
  expect(await Bun.file(legacy).text()).toBe("do not read or replace this legacy state\n");
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
    databaseBefore,
  );
  expect(
    (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toSorted(),
  ).toEqual([".operator/install/selection.json", "state/operator/operator.sqlite"]);
});

function expectHelp(text: string) {
  expect(text).toStartWith("Usage: operator --help | --version [--json]\n");
  expect(text).toContain("operator review add <pr-url> [--slack-thread permalink] [--json]");
  expect(text).toContain("operator review wait [--timeout seconds] [--all] [--json]");
  expect(text).toEndWith("operator opencode hook\n");
  for (const removed of ["review ingest", "review slack-done", "review slack-drop", "[--slack]"])
    expect(text).not.toContain(removed);
}

test("help names only the available commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-cli-help-"));
  roots.push(root);
  const databaseBefore = await registerTestDevice(root);
  const child = Bun.spawn([process.execPath, cli, "--help"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Environment.child(),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      XDG_CACHE_HOME: undefined,
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  expectHelp(output);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
    "state/operator/operator.sqlite",
  ]);
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
    databaseBefore,
  );
});

test.each(
  [
    ["setup", "apply"],
    ["setup", "probe", "apply"],
    ["install"],
    ["update", "apply"],
    ["healthcheck"],
    ["crew", "own"],
    ["crew", "next"],
    ["work", "register"],
    ["work", "claim"],
    ["work", "accept"],
    ["work", "frontier"],
    ["attempt", "dispatch"],
    ["attempt", "submit"],
    ["question", "raise"],
    ["approval", "grant"],
    ["review", "report"],
    ["rework"],
    ["invalidate"],
    ["outside"],
    ["gate", "run"],
    ["publish", "apply"],
    ["tracker", "record"],
    ["cleanup", "remove"],
    ["wake", "check"],
    ["unknown"],
    ["--version", "--version"],
    ["review", "ingest", "--input", "-"],
    ["review", "slack-done", "id", "--input", "-"],
    ["review", "slack-drop", "id", "--person-instructed"],
    ["review", "wait", "--slack"],
  ].map((args) => ({ args })),
)("rejects removed or invalid command %j without writes or external effects", async ({ args }) => {
  const root = await mkdtemp(join(tmpdir(), "operator-cli-refusal-"));
  roots.push(root);
  const databaseBefore = await registerTestDevice(root);
  const legacy = `${root}/.operator/untouched`;
  await Bun.write(legacy, "unfinished work\n", { createPath: true });
  const child = Bun.spawn([process.execPath, cli, ...args, "--json"], {
    cwd: root,
    env: {
      ...Environment.child(),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      XDG_CACHE_HOME: undefined,
      PATH: `${root}/no-tools`,
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).json().then((value) => z.unknown().parse(value)),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(2);
  expect(output).toMatchObject({
    schemaVersion: 1,
    reason: "invalid_arguments",
    outcome: "invalid",
  });
  expectHelp(error);
  expect(await Bun.file(legacy).text()).toBe("unfinished work\n");
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
    databaseBefore,
  );
  expect(
    (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toSorted(),
  ).toEqual([".operator/untouched", "state/operator/operator.sqlite"]);
});
