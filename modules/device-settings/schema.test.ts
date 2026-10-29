import { expect, test } from "bun:test";
import { editorSchemaText, settingsSchema } from "./schema.ts";

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

test("trims selection text and accepts only safe profile names", () => {
  expect(
    settingsSchema.parse({ superAgent: { model: " chosen ", reasoningEffort: " high " } })
      .superAgent,
  ).toEqual({ model: "chosen", reasoningEffort: "high" });
  expect(settingsSchema.safeParse({ profiles: { "study-2": {} } }).success).toBe(true);
  for (const name of ["prototype", "2study", "study_2", "Study"])
    expect(settingsSchema.safeParse({ profiles: { [name]: {} } }).success).toBe(false);
});

test("reports an own __proto__ profile as a custom issue", () => {
  const result = settingsSchema.safeParse({ profiles: JSON.parse('{"__proto__":{}}') as unknown });
  expect(result.error?.issues).toMatchObject([
    { code: "custom", path: ["profiles"], message: "Unsupported profile name: __proto__." },
  ]);
});

test("accepts the Slack review policy fields with GitHub identities", () => {
  const review = {
    assignments: true,
    channel: "C0123ABCD",
    repos: ["1org/repo2", "o1rg/operator.js", "fveracoechea/my_repo-1"],
    authors: ["octocat", "1octo", "o1cto-cat", "renovate[bot]"],
  };
  expect(settingsSchema.parse({ review }).review).toEqual(review);
});

test.each([
  { channel: "XC0123ABCD" },
  { channel: "C0123abcd" },
  { channel: "C1" },
  { channel: "c0123ABCD" },
  { repos: ["-org/repo"] },
  { repos: ["org/repo/extra"] },
  { repos: ["Org/repo"] },
  { repos: ["org/"] },
  { authors: ["-octo"] },
  { authors: ["octo cat"] },
  { authors: ["octo[bot]x"] },
  { other: true },
])("rejects the review setting %j", (review) => {
  expect(settingsSchema.safeParse({ review }).success).toBe(false);
});

test("accepts the editor schema path but no other $schema value", () => {
  expect(settingsSchema.parse({ $schema: "./config.schema.json" }).$schema).toBe(
    "./config.schema.json",
  );
});

test("renders the editor schema as indented JSON with a final newline", () => {
  const text = editorSchemaText();
  expect(text.endsWith("}\n")).toBe(true);
  expect(text.split("\n")[1]).toStartWith('  "');
  expect(JSON.parse(text)).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: { const: "./config.schema.json", default: "./config.schema.json" },
      superAgent: { type: "object" },
      review: { type: "object", properties: { channel: { type: "string" } } },
    },
  });
});
