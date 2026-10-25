import { expect, test } from "bun:test";
import { parseEdits, editConfig } from "./edits.ts";
import { settingsSchema } from "./schema.ts";

test("sorts edits and changes only the selected role fields", () => {
  const edits = parseEdits(
    ["workerAgent.host=claude-code", "superAgent.model=openai/test"],
    ["workerAgent.model"],
  );
  expect(edits).toEqual({
    edits: [
      { path: "superAgent.model", value: "openai/test" },
      { path: "workerAgent.host", value: "claude-code" },
      { path: "workerAgent.model", value: null },
    ],
  });
  const original = settingsSchema.parse({ workerAgent: { model: "old" } });
  const changed = editConfig(original, edits.edits ?? []);
  expect(changed.success && changed.data).toEqual({
    $schema: "./config.schema.json",
    superAgent: { model: "openai/test" },
    workerAgent: { host: "claude-code" },
  });
  expect(original.workerAgent.model).toBe("old");
});

test.each([
  { sets: [], unsets: [] },
  { sets: ["superAgent.host="], unsets: [] },
  { sets: ["superAgent.host"], unsets: [] },
  { sets: ["superAgent.host=opencode"], unsets: ["superAgent.host"] },
  { sets: ["projects.example.host=opencode"], unsets: [] },
  { sets: ["crew.maxActiveAgents=3"], unsets: [] },
  { sets: [], unsets: ["superAgent.host=value"] },
])("refuses invalid or conflicting edit arguments %j", ({ sets, unsets }) => {
  expect(parseEdits([...sets], [...unsets]).issues?.length).toBeGreaterThan(0);
});

test("validates the complete changed settings", () => {
  expect(
    editConfig(settingsSchema.parse({}), [{ path: "superAgent.host", value: "unsupported" }])
      .success,
  ).toBe(false);
  expect(
    editConfig(settingsSchema.parse({}), [
      { path: "workerAgent.reasoningEffort", value: "extreme" },
    ]).success,
  ).toBe(false);
});
