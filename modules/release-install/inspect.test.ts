import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import type { Installation } from "./inspect.ts";
import { ReleaseInstall } from "./main.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const selection = {
  schemaVersion: 1 as const,
  delivery: "jsr" as const,
  version: "0.4.0",
  commit: "a".repeat(40),
  releaseIdentity: "b".repeat(64),
  skillsIdentity: "c".repeat(64),
  packageVersion: "0.4.0",
  upstreamSkills: [],
  selectedAt: "2026-10-03T00:00:00.000Z",
};
const running = {
  version: "0.4.0",
  identity: selection.releaseIdentity,
  commit: null,
  lock: { state: "present" as const },
};
const script = "bun node_modules/@fveracoechea/operator/cli.js";
const dependencies = { "@fveracoechea/operator": "npm:@jsr/fveracoechea__operator@0.4.0" };

async function project(files: Record<string, unknown>): Promise<string> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-jsr-inspect-${crypto.randomUUID()}`;
  roots.push(root);
  await ReleaseInstall.select({ projectRoot: root, selection });
  for (const [path, body] of Object.entries(files)) {
    await Bun.write(`${root}/${path}`, typeof body === "string" ? body : JSON.stringify(body), {
      createPath: true,
    });
  }
  return root;
}

const installedManifest = {
  "node_modules/@fveracoechea/operator/package.json": { version: "0.4.0" },
};
const declared = { scripts: { operator: script }, devDependencies: dependencies };

test("accepts the declared, installed, and locked JSR release", async () => {
  const root = await project({ "package.json": declared, ...installedManifest, "bun.lock": "{}" });
  expect(await ReleaseInstall.inspect({ projectRoot: root, running })).toEqual({
    status: "installed",
    selection,
    detail: `Operator 0.4.0 from jsr at commit ${selection.commit} is selected and running.`,
  });
});

const declarationRefusal: Installation = {
  status: "unmet",
  reason: "install_missing",
  selection,
  detail:
    "The project must declare @fveracoechea/operator as the exact JSR devDependency npm:@jsr/fveracoechea__operator@0.4.0 and set scripts.operator to bun node_modules/@fveracoechea/operator/cli.js.",
  nextAction:
    "Add the selected JSR devDependency and Operator script to package.json, then run `bun install --frozen-lockfile` from the project root.",
  paths: ["package.json"],
};

test.each([
  ["no devDependencies", { scripts: { operator: script } }],
  ["a different script", { scripts: { operator: "bun other.js" }, devDependencies: dependencies }],
  // The project check reads every script as text, so one other script that is not text refuses.
  [
    "a script that is not text",
    { scripts: { operator: script, other: 1 }, devDependencies: dependencies },
  ],
])("refuses a project manifest with %s", async (_name, manifest) => {
  const root = await project({ "package.json": manifest, ...installedManifest, "bun.lock": "{}" });
  expect(await ReleaseInstall.inspect({ projectRoot: root, running })).toEqual(declarationRefusal);
});

test("refuses a project that holds no installed package", async () => {
  const root = await project({ "package.json": declared, "bun.lock": "{}" });
  expect(await ReleaseInstall.inspect({ projectRoot: root, running })).toEqual({
    status: "unmet",
    reason: "install_missing",
    selection,
    detail:
      "The project holds no installed @fveracoechea/operator, so the selected release is not present.",
    nextAction: "Run `bun install --frozen-lockfile` from the project root, then check again.",
    paths: ["node_modules/@fveracoechea/operator/package.json"],
  });
});

test.each([
  ["0.3.0", "0.3.0"],
  ["a package that names no version", {}],
])("refuses an installation that holds %s", async (held, manifest) => {
  const root = await project({
    "package.json": declared,
    "node_modules/@fveracoechea/operator/package.json":
      typeof manifest === "string" ? { version: manifest } : manifest,
    "bun.lock": "{}",
  });
  expect(await ReleaseInstall.inspect({ projectRoot: root, running })).toEqual({
    status: "unmet",
    reason: "release_mismatch",
    selection,
    detail: `This project selected @fveracoechea/operator@0.4.0, and the installation holds ${held}.`,
    nextAction:
      "Install @fveracoechea/operator@0.4.0 from JSR in the project root, then check again.",
    paths: ["node_modules/@fveracoechea/operator/package.json"],
  });
});

test("refuses a project that holds no lock data", async () => {
  const root = await project({ "package.json": declared, ...installedManifest });
  expect(await ReleaseInstall.inspect({ projectRoot: root, running })).toEqual({
    status: "unmet",
    reason: "lock_data_missing",
    selection,
    detail:
      "The project holds no lock data, so a reinstall would resolve its dependencies again instead of repeating them.",
    nextAction:
      "Restore the project bun.lock, then run `bun install --frozen-lockfile` from the project root.",
    paths: ["bun.lock"],
  });
});

test("accepts a binary lock as lock data", async () => {
  const root = await project({ "package.json": declared, ...installedManifest, "bun.lockb": "x" });
  expect(await ReleaseInstall.inspect({ projectRoot: root, running })).toMatchObject({
    status: "installed",
  });
});
