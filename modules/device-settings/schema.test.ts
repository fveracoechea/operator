import { expect, test } from "bun:test";
import { settingsSchema } from "./schema.ts";

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
