import { expect, test } from "bun:test";
import { editorSchemaText, settingsSchema } from "./schema.ts";

test("settings accept optional custom kinds and preserve their normalized policy", () => {
  expect(settingsSchema.parse({})).not.toHaveProperty("kinds");
  expect(
    settingsSchema.parse({
      kinds: {
        audit: {
          completion: "report",
          resources: "pane",
          guide: "audit-guide/SKILL.md",
          workPhases: [{ name: " audit ", goal: " Check evidence. " }],
        },
      },
    }),
  ).toEqual({
    $schema: "./config.schema.json",
    superAgent: {},
    workerAgent: {},
    kinds: {
      audit: {
        completion: "report",
        resources: "pane",
        guide: "audit-guide/SKILL.md",
        profile: null,
        nextKind: null,
        readsNote: false,
        dispatchable: true,
        skillsToRead: [],
        workPhases: [{ name: "audit", goal: "Check evidence." }],
      },
    },
  });
});

test("settings reject invalid custom definitions and publish kinds in the editor schema", () => {
  expect(settingsSchema.safeParse({ kinds: { audit: {} } }).success).toBe(false);
  const editor: unknown = JSON.parse(editorSchemaText());
  expect(editor).toHaveProperty("properties.kinds.type", "object");
  expect(editor).toHaveProperty("required", ["$schema", "superAgent", "workerAgent"]);
  expect(editor).toHaveProperty(
    "properties.kinds.additionalProperties.properties.guide",
    expect.objectContaining({
      type: "string",
      pattern: "^[a-z][a-z0-9-]*\\/SKILL\\.md$",
    }),
  );
});
