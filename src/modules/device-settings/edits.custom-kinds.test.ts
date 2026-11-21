import { expect, test } from "bun:test";
import { editConfig, parseEdits } from "./edits.ts";
import { settingsSchema } from "./schema.ts";

const definition = {
  completion: "report",
  resources: "pane",
  guide: "audit-guide/SKILL.md",
  workPhases: [{ name: "audit", goal: "Audit the evidence." }],
};

test("whole-kind edits round-trip JSON and unset without mutating the original settings", () => {
  const original = settingsSchema.parse({});
  const parsed = parseEdits([`kinds.audit=${JSON.stringify(definition)}`], []);
  expect(parsed).toEqual({ edits: [{ path: "kinds.audit", value: JSON.stringify(definition) }] });
  const added = editConfig(original, [{ path: "kinds.audit", value: JSON.stringify(definition) }]);
  expect(added).toMatchObject({ success: true, data: { kinds: { audit: definition } } });
  expect(original).not.toHaveProperty("kinds");
  if (!added.success) return;
  expect(editConfig(added.data, [{ path: "kinds.audit", value: null }])).toMatchObject({
    success: true,
    data: { kinds: {} },
  });
  expect(added.data.kinds?.audit).toMatchObject(definition);
});

test.each(["kinds.Audit={}", "kinds.audit.guide=x", "kinds.audit=", "kinds.audit"])(
  "rejects malformed whole-kind edit %s",
  (edit) => expect(parseEdits([edit], [])).toHaveProperty("issues"),
);

test("refuses duplicate edits and invalid definitions rather than partially changing settings", () => {
  expect(parseEdits([`kinds.audit=${JSON.stringify(definition)}`], ["kinds.audit"])).toEqual({
    issues: ["Settings field kinds.audit was named more than once."],
  });
  const original = settingsSchema.parse({ kinds: { audit: definition } });
  expect(editConfig(original, [{ path: "kinds.audit", value: "{}" }]).success).toBe(false);
  expect(original.kinds?.audit).toMatchObject(definition);
});
