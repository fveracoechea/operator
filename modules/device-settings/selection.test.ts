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
    for (const config of [settingsSchema.parse({ profiles: {} }), settingsSchema.parse({})])
      expect(selectLaunch(config, { profile })).toEqual({
        reason: "profile_missing",
        detail: `Start profile ${profile} does not exist.`,
      });
  },
);

test("uses a profile only when the request names it", () => {
  const config = settingsSchema.parse({
    superAgent: { host: "opencode", model: "provider/model" },
    profiles: { undefined: { host: "claude-code" } },
  });
  expect(selectLaunch(config, {})).toMatchObject({ host: "opencode", profile: null });
  expect(selectLaunch(config, { profile: "undefined" })).toMatchObject({
    host: "claude-code",
    profile: "undefined",
  });
});

test("only the WorkerAgent role takes the WorkerAgent settings", () => {
  const config = settingsSchema.parse({
    superAgent: { host: "opencode", model: "provider/super" },
    workerAgent: { host: "claude-code", model: "provider/worker" },
  });
  expect(selectLaunch(config, { role: "superAgent" })).toEqual({
    host: "opencode",
    model: "provider/super",
    reasoningEffort: "high",
    role: "superAgent",
    profile: null,
  });
  expect(selectLaunch(config, { role: "workerAgent" })).toEqual({
    host: "claude-code",
    model: "provider/worker",
    reasoningEffort: "medium",
    role: "workerAgent",
    profile: null,
  });
});

test.each([{}, { host: "opencode" }, { model: "provider/model" }])(
  "does not infer a host or model from %j",
  (superAgent) => {
    expect(selectLaunch(settingsSchema.parse({ superAgent }), {})).toEqual({
      reason: "selection_incomplete",
      detail:
        "Set a host and model in device settings or explicit launch overrides. Operator does not choose a model for you.",
    });
  },
);
