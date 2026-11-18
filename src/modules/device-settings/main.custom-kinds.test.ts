import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceSettings } from "./main.ts";

const root = await mkdtemp("/tmp/opencode/pr424-kind-settings-");
afterAll(() => rm(root, { recursive: true, force: true }));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));

test("kind lookup chooses the selected host's owned guide before its upstream guide", async () => {
  const definition = {
    completion: "report",
    resources: "pane",
    guide: "audit-guide/SKILL.md",
    workPhases: [{ name: "audit", goal: "Check evidence." }],
  };
  await Bun.write(paths.config, JSON.stringify({ kinds: { audit: definition } }), {
    createPath: true,
  });
  const owned = `${paths.skillHosts.opencode}/audit-guide/SKILL.md`;
  const upstream = `${paths.upstreamSkills.opencode}/audit-guide/SKILL.md`;
  await Bun.write(owned, "Owned.", { createPath: true });
  await Bun.write(upstream, "Upstream.", { createPath: true });
  const request = { paths, name: "audit", host: "opencode" as const };
  expect(await DeviceSettings.kind(request)).toMatchObject({
    tag: "Ok",
    value: { name: "audit", guide: owned, completion: "report" },
  });
  await rm(owned);
  expect(await DeviceSettings.kind(request)).toMatchObject({
    tag: "Ok",
    value: { guide: upstream },
  });
  expect(await DeviceSettings.kind({ ...request, host: "claude-code" })).toMatchObject({
    tag: "Err",
    error: { reason: "invalid_settings", state: { settingsValid: false } },
  });
  const claude = `${paths.skillHosts["claude-code"]}/audit-guide/SKILL.md`;
  await Bun.write(claude, "Claude.", { createPath: true });
  expect(await DeviceSettings.kind({ ...request, host: "claude-code" })).toMatchObject({
    tag: "Ok",
    value: { guide: claude },
  });
});
