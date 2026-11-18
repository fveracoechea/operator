import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { apply, plan } from "./change.ts";

const root = await mkdtemp(path.join(tmpdir(), "pr424-kind-change-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const definition = {
  completion: "report",
  resources: "pane",
  guide: "audit-guide/SKILL.md",
  workPhases: [{ name: "audit", goal: "Check evidence." }],
};

test("custom-kind planning and applying both refuse absent guides before writing", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/refusal`, NODE_ENV: "test" }),
  );
  const request = { paths, sets: [`kinds.audit=${JSON.stringify(definition)}`], unsets: [] };
  await expect(plan(request)).rejects.toThrow(SyntaxError);
  await expect(apply({ ...request, planId: "inspected" })).rejects.toThrow(SyntaxError);
  expect(await Bun.file(paths.config).exists()).toBe(false);
  expect(await Bun.file(paths.receipt).exists()).toBe(false);
  expect(await Bun.file(paths.writeLock).exists()).toBe(false);
});

test("a planned custom kind is persisted only with its inspected plan and still-installed guide", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/apply`, NODE_ENV: "test" }),
  );
  const guide = `${paths.skillHosts.opencode}/audit-guide/SKILL.md`;
  await Bun.write(guide, "Audit.", { createPath: true });
  const request = { paths, sets: [`kinds.audit=${JSON.stringify(definition)}`], unsets: [] };
  const planned = z
    .object({ reason: z.literal("settings_planned"), data: z.object({ planId: z.string() }) })
    .parse(await plan(request));
  expect(await Bun.file(paths.config).exists()).toBe(false);
  await rm(guide);
  await expect(apply({ ...request, planId: planned.data.planId })).rejects.toThrow(SyntaxError);
  expect(await Bun.file(paths.receipt).exists()).toBe(false);
  await Bun.write(guide, "Audit.");
  expect(await apply({ ...request, planId: planned.data.planId })).toMatchObject({
    reason: "settings_applied",
    data: { after: { kinds: { audit: definition } } },
  });
  expect(JSON.parse(await Bun.file(paths.config).text())).toMatchObject({
    kinds: { audit: definition },
  });
  expect(await apply({ ...request, planId: planned.data.planId })).toMatchObject({
    reason: "settings_unchanged",
    data: { repeated: true },
  });
});
