import { expect, test } from "bun:test";
import { settingsSchema } from "./schema.ts";
import { selectLaunch } from "./selection.ts";

test("inherits host and model but not SuperAgent effort", () => {
  const config = settingsSchema.parse({
    superAgent: { host: "opencode", model: "provider/model", reasoningEffort: "max" },
  });
  expect(selectLaunch(config, {})).toEqual({
    host: "opencode",
    model: "provider/model",
    reasoningEffort: "medium",
    role: "workerAgent",
    profile: null,
  });
  expect(selectLaunch(config, { role: "superAgent" })).toMatchObject({ reasoningEffort: "max" });
  expect(
    selectLaunch(
      settingsSchema.parse({ superAgent: { host: "opencode", model: "provider/model" } }),
      { role: "superAgent" },
    ),
  ).toMatchObject({ reasoningEffort: "high" });
});

test("overrides each field in role, profile, and explicit launch order without changing settings", () => {
  const config = settingsSchema.parse({
    superAgent: { host: "opencode", model: "provider/model" },
    workerAgent: { model: "provider/worker" },
    profiles: { exploration: { host: "claude-code", reasoningEffort: "low" } },
  });
  const before = structuredClone(config);
  expect(
    selectLaunch(config, {
      profile: "exploration",
      overrides: { model: "precise-model", reasoningEffort: "high" },
    }),
  ).toEqual({
    host: "claude-code",
    model: "precise-model",
    reasoningEffort: "high",
    role: "workerAgent",
    profile: "exploration",
  });
  expect(config).toEqual(before);
});

test.each(["missing", "constructor", "toString", "__proto__"])(
  "refuses absent or inherited profile %s",
  (profile) => {
    expect(selectLaunch(settingsSchema.parse({ profiles: {} }), { profile })).toMatchObject({
      reason: "profile_missing",
    });
  },
);

test("does not infer a host or model", () => {
  expect(selectLaunch(settingsSchema.parse({}), {})).toMatchObject({
    reason: "selection_incomplete",
  });
});
