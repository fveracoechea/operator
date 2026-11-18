import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { sha256 } from "../../lib/sha256.ts";
import { readConfig } from "./storage.ts";

const root = await mkdtemp("/tmp/opencode/pr424-kind-storage-");
afterAll(() => rm(root, { recursive: true, force: true }));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));

test("reading custom kinds validates installed guides without rewriting settings bytes", async () => {
  const text = JSON.stringify({
    kinds: {
      audit: {
        completion: "report",
        resources: "pane",
        guide: "audit-guide/SKILL.md",
        workPhases: [{ name: "audit", goal: "Check evidence." }],
      },
    },
  });
  await Bun.write(paths.config, text, { createPath: true });
  await expect(readConfig(paths)).rejects.toThrow(SyntaxError);
  expect(await Bun.file(paths.config).text()).toBe(text);
  await Bun.write(`${paths.upstreamSkills.opencode}/audit-guide/SKILL.md`, "Audit.", {
    createPath: true,
  });
  expect(await readConfig(paths)).toMatchObject({
    exists: true,
    text,
    identity: sha256(text),
    config: { kinds: { audit: { profile: null, nextKind: null, dispatchable: true } } },
  });
  expect(await Bun.file(paths.config).text()).toBe(text);
  expect(await Bun.file(paths.receipt).exists()).toBe(false);
});
