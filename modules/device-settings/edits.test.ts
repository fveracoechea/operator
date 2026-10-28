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
  { sets: ["profiles.study.model=chosen"], unsets: ["profiles.study"] },
  { sets: ["profiles.__proto__.model=chosen"], unsets: [] },
  { sets: ["profiles.constructor.host=opencode"], unsets: [] },
  { sets: ["profiles.study.permissions=allow"], unsets: [] },
  { sets: ["profiles.study=chosen"], unsets: [] },
  { sets: ["profiles.study.model.extra=chosen"], unsets: [] },
])("refuses invalid or conflicting edit arguments %j", ({ sets, unsets }) => {
  expect(parseEdits([...sets], [...unsets]).issues?.length).toBeGreaterThan(0);
});

test("removes one profile field or a complete named profile without changing other profiles", () => {
  const original = settingsSchema.parse({
    profiles: { study: { host: "opencode", model: "chosen" }, other: { reasoningEffort: "high" } },
  });
  const unset = parseEdits([], ["profiles.study.model"]);
  const changed = editConfig(original, unset.edits ?? []);
  expect(changed.success && changed.data.profiles).toEqual({
    study: { host: "opencode" },
    other: { reasoningEffort: "high" },
  });
  const removed = editConfig(original, [{ path: "profiles.study", value: null }]);
  expect(removed.success && removed.data.profiles).toEqual({ other: { reasoningEffort: "high" } });
  expect(original.profiles?.study?.model).toBe("chosen");
});

test("validates the complete changed settings", () => {
  expect(
    editConfig(settingsSchema.parse({}), [{ path: "superAgent.host", value: "unsupported" }])
      .success,
  ).toBe(false);
  expect(
    editConfig(settingsSchema.parse({}), [{ path: "workerAgent.reasoningEffort", value: " " }])
      .success,
  ).toBe(false);
});

test("the optional assignment reviewer is a boolean that is off until it is set", () => {
  expect(settingsSchema.parse({}).review).toBeUndefined();
  for (const value of ["yes", "1", "TRUE", ""])
    expect(parseEdits([`review.assignments=${value}`], []).issues?.length).toBeGreaterThan(0);
  expect(parseEdits(["review.other=true"], []).issues?.length).toBeGreaterThan(0);
  const on = editConfig(
    settingsSchema.parse({}),
    parseEdits(["review.assignments=true"], []).edits ?? [],
  );
  expect(on.success && on.data.review).toEqual({ assignments: true });
  const off = editConfig(on.success ? on.data : settingsSchema.parse({}), [
    { path: "review.assignments", value: "false" },
  ]);
  expect(off.success && off.data.review).toEqual({ assignments: false });
  const unset = editConfig(
    on.success ? on.data : settingsSchema.parse({}),
    parseEdits([], ["review.assignments"]).edits ?? [],
  );
  expect(unset.success && unset.data.review).toEqual({});
  expect(settingsSchema.safeParse({ review: { assignments: "true" } }).success).toBe(false);
});

test("edits the Slack author policy as a channel id, lowercase repositories, and GitHub logins", () => {
  const edits = parseEdits(
    ["review.channel=C0REVIEW", "review.repos=Owner/One, owner/two", "review.authors=Alice,bob-2"],
    [],
  );
  const changed = editConfig(
    settingsSchema.parse({ review: { assignments: true } }),
    edits.edits ?? [],
  );
  expect(changed.success && changed.data.review).toEqual({
    assignments: true,
    channel: "C0REVIEW",
    repos: ["owner/one", "owner/two"],
    authors: ["Alice", "bob-2"],
  });
  const unset = parseEdits([], ["review.channel", "review.repos", "review.authors"]);
  const removed = editConfig(
    changed.success ? changed.data : settingsSchema.parse({}),
    unset.edits ?? [],
  );
  expect(removed.success && removed.data.review).toEqual({ assignments: true });
});

test.each([
  "review.channel=#reviews",
  "review.channel=general",
  "review.repos=owner",
  "review.repos=owner/one/extra",
  "review.authors=@alice",
  "review.authors=Alice Smith",
])("refuses the Slack policy value %s", (set) => {
  const edits = parseEdits([set], []);
  expect(edits.issues).toBeUndefined();
  expect(editConfig(settingsSchema.parse({}), edits.edits ?? []).success).toBe(false);
});
