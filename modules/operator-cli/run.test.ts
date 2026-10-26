import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no temporary directory or recursive directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

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
    new Response(child.stdout).json().then((value: unknown) => versionOutput.parse(value)),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(error).toBe("");
  expect(output.reason).toBe("version_reported");
  expect(output.data.operatorVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(output.data).not.toHaveProperty("selection");
  expect(await Bun.file(legacy).text()).toBe("do not read or replace this legacy state\n");
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
    ".operator/install/selection.json",
  ]);
});

test("help names only the available commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-cli-help-"));
  roots.push(root);
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
  expect(output).toBe(
    "Usage: operator --help | --version [--json]\n       operator config show | recover [--json]\n       operator config plan | apply (--set field=value | --unset field)... [--plan id] [--json]\n       operator host models --host opencode|claude-code [--json]\n       operator config resolve [--role superAgent|workerAgent] [--profile name] [--host host] [--model model] [--effort effort] [--json]\n       operator project register [--repository owner/repository] [--json]\n       operator project show [--json]\n",
  );
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([]);
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
  ].map((args) => ({ args })),
)("rejects removed or invalid command %j without writes or external effects", async ({ args }) => {
  const root = await mkdtemp(join(tmpdir(), "operator-cli-refusal-"));
  roots.push(root);
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
    new Response(child.stdout).json().then((value: unknown) => z.unknown().parse(value)),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(2);
  expect(output).toMatchObject({
    schemaVersion: 1,
    reason: "invalid_arguments",
    outcome: "invalid",
  });
  expect(error).toBe(
    "Usage: operator --help | --version [--json]\n       operator config show | recover [--json]\n       operator config plan | apply (--set field=value | --unset field)... [--plan id] [--json]\n       operator host models --host opencode|claude-code [--json]\n       operator config resolve [--role superAgent|workerAgent] [--profile name] [--host host] [--model model] [--effort effort] [--json]\n       operator project register [--repository owner/repository] [--json]\n       operator project show [--json]\n",
  );
  expect(await Bun.file(legacy).text()).toBe("unfinished work\n");
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
    ".operator/untouched",
  ]);
});
