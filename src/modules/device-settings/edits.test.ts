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

function unsupported(raw: string) {
  return `Unsupported settings field: ${raw}.`;
}
function repeated(key: string) {
  return `Settings field ${key} was named more than once.`;
}
function empty(key: string) {
  return `Set ${key} with a non-empty path=value argument.`;
}

test.each([
  { sets: [], unsets: [], issues: ["Name at least one --set or --unset field."] },
  { sets: ["superAgent.host="], unsets: [], issues: [empty("superAgent.host")] },
  { sets: ["superAgent.host= "], unsets: [], issues: [empty("superAgent.host")] },
  { sets: ["review.channel"], unsets: [], issues: [empty("review.channel")] },
  { sets: ["review.channelX"], unsets: [], issues: [unsupported("review.channelX")] },
  { sets: ["superAgent.host"], unsets: [], issues: [empty("superAgent.host")] },
  {
    sets: ["xsuperAgent.host=opencode"],
    unsets: [],
    issues: [unsupported("xsuperAgent.host=opencode")],
  },
  {
    sets: ["superAgent.host=opencode"],
    unsets: ["superAgent.host"],
    issues: [repeated("superAgent.host")],
  },
  {
    sets: ["projects.example.host=opencode"],
    unsets: [],
    issues: [unsupported("projects.example.host=opencode")],
  },
  { sets: ["crew.maxActiveAgents=3"], unsets: [], issues: [unsupported("crew.maxActiveAgents=3")] },
  { sets: [], unsets: ["superAgent.host=value"], issues: [unsupported("superAgent.host=value")] },
  {
    sets: ["profiles.study.model=chosen"],
    unsets: ["profiles.study"],
    issues: [repeated("profiles.study")],
  },
  {
    sets: [],
    unsets: ["profiles.study", "profiles.study.model"],
    issues: [repeated("profiles.study.model")],
  },
  {
    sets: ["profiles.__proto__.model=chosen"],
    unsets: [],
    issues: [unsupported("profiles.__proto__.model=chosen")],
  },
  {
    sets: ["profiles.constructor.host=opencode"],
    unsets: [],
    issues: [unsupported("profiles.constructor.host=opencode")],
  },
  {
    sets: ["profiles.study.permissions=allow"],
    unsets: [],
    issues: [unsupported("profiles.study.permissions=allow")],
  },
  {
    sets: ["profiles.study.xmodel=chosen"],
    unsets: [],
    issues: [unsupported("profiles.study.xmodel=chosen")],
  },
  {
    sets: ["profiles.study.modelx=chosen"],
    unsets: [],
    issues: [unsupported("profiles.study.modelx=chosen")],
  },
  { sets: ["profiles.study=chosen"], unsets: [], issues: [unsupported("profiles.study=chosen")] },
  {
    sets: ["profiles.study.model.extra=chosen"],
    unsets: [],
    issues: [unsupported("profiles.study.model.extra=chosen")],
  },
])("refuses invalid or conflicting edit arguments %j", ({ sets, unsets, issues }) => {
  expect(parseEdits([...sets], [...unsets])).toEqual({ issues: [...issues] });
});

test("accepts one profile field set and one complete profile unset", () => {
  expect(parseEdits(["profiles.study.model=chosen"], ["profiles.old"])).toEqual({
    edits: [
      { path: "profiles.old", value: null },
      { path: "profiles.study.model", value: "chosen" },
    ],
  });
  expect(parseEdits(["review.assignments=false"], [])).toEqual({
    edits: [{ path: "review.assignments", value: "false" }],
  });
});

test("an edit with no named field or profile changes nothing", () => {
  const original = settingsSchema.parse({ profiles: { undefined: { host: "opencode" } } });
  for (const edit of [
    { path: "profiles", value: null },
    { path: "superAgent", value: "opencode" },
  ]) {
    const changed = editConfig(original, [edit]);
    expect(changed.success && changed.data).toEqual(original);
  }
});

test("unsets a complete profile when no profiles exist", () => {
  const changed = editConfig(settingsSchema.parse({}), [{ path: "profiles.study", value: null }]);
  expect(changed.success && changed.data).toEqual(settingsSchema.parse({}));
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

test("internal review is a boolean that stays unset until the person turns it off or on", () => {
  for (const value of ["no", "0", "FALSE", ""])
    expect(parseEdits([`review.internal=${value}`], []).issues).toEqual([
      `Unsupported settings field: review.internal=${value}.`,
    ]);
  const off = editConfig(
    settingsSchema.parse({ review: { assignments: true } }),
    parseEdits(["review.internal=false"], []).edits ?? [],
  );
  expect(off.success && off.data.review).toEqual({ assignments: true, internal: false });
  const on = editConfig(off.success ? off.data : settingsSchema.parse({}), [
    { path: "review.internal", value: "true" },
  ]);
  expect(on.success && on.data.review).toEqual({ assignments: true, internal: true });
  const unset = editConfig(
    off.success ? off.data : settingsSchema.parse({}),
    parseEdits([], ["review.internal"]).edits ?? [],
  );
  expect(unset.success && unset.data.review).toEqual({ assignments: true });
  expect(settingsSchema.safeParse({ review: { internal: "false" } }).success).toBe(false);
});

test("edits the Slack author policy as a channel id, lowercase repositories, and GitHub logins", () => {
  const edits = parseEdits(
    [
      "review.channel=C0REVIEW",
      "review.repos=Owner/One,, owner/two,",
      "review.authors=Alice,bob-2",
    ],
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
