import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceSettings } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-settings-module-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("returns expected edit failures as Err and does not write", async () => {
  const result = await DeviceSettings.apply({
    paths,
    sets: ["superAgent.host=opencode"],
    unsets: [],
  });
  expect(result.tag).toBe("Err");
  if (result.tag === "Err") {
    expect(result.error.reason).toBe("settings_plan_required");
    expect(result.error).not.toHaveProperty("exitCode");
  }
  expect(await Bun.file(paths.config).exists()).toBe(false);
});

test("qualifies invalid input separately from unexpected defects", async () => {
  await Bun.write(paths.config, "{invalid", { createPath: true });
  const invalid = await DeviceSettings.show(paths);
  expect(invalid.tag).toBe("Err");
  if (invalid.tag === "Err") expect(invalid.error.reason).toBe("invalid_settings");
  const defect = await DeviceSettings.show({ ...paths, config: "\0" });
  expect(defect.tag).toBe("Defect");
});
