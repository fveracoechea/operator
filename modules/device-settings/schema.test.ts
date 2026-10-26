import { expect, test } from "bun:test";
import { settingsSchema } from "./schema.ts";

test("accepts extensible profiles but no permission policy or unsafe names", () => {
  expect(
    settingsSchema.safeParse({
      profiles: { study: { host: "claude-code", reasoningEffort: "xhigh" } },
    }).success,
  ).toBe(true);
  for (const profiles of [
    { study: { permissionMode: "bypass" } },
    { constructor: {} },
    JSON.parse('{"__proto__":{}}') as unknown,
  ]) {
    expect(settingsSchema.safeParse({ profiles }).success).toBe(false);
  }
});

test("defaults only absent settings and supports both host defaults", () => {
  expect(settingsSchema.parse({})).toEqual({
    $schema: "./config.schema.json",
    superAgent: {},
    workerAgent: {},
  });
  expect(
    settingsSchema.parse({
      superAgent: { host: "opencode", reasoningEffort: "high" },
      workerAgent: { host: "claude-code", model: "selected", reasoningEffort: "medium" },
    }).workerAgent.model,
  ).toBe("selected");
});

test.each([
  { projects: {} },
  { crew: {} },
  { probe: {} },
  { superAgent: { host: "other" } },
  { workerAgent: { permissions: "allow" } },
  { superAgent: { model: " " } },
  { $schema: "outside.json" },
])("rejects removed or unsupported configuration %j", (value) => {
  expect(settingsSchema.safeParse(value).success).toBe(false);
});
