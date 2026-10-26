import { expect, test } from "bun:test";
import { commitIdentity, installed, roster } from "./catalog.ts";

test("selects every distinct non-owned name, including cursor and unslop", () => {
  const documents = ["code-review", "bun", "cursor", "unslop", "super-agent", "code-review"].map(
    (name) => `---\nname: ${name}\ndescription: A skill.\n---\n`,
  );
  expect(roster(documents, ["bun", "super-agent"])).toEqual(["code-review", "cursor", "unslop"]);
});
test.each([
  "no frontmatter",
  "---\nname: ../escape\n---\n",
  "---\nname: --all\n---\n",
  "---\nname: '*'\n---\n",
  "---\ndescription: missing name\n---\n",
])("rejects invalid roster input %s rather than broaden installer scope", (document) => {
  expect(() => roster([document], [])).toThrow();
});
test("accepts only a full resolved commit", () => {
  expect(commitIdentity(`${"a".repeat(40)}\n`)).toBe("a".repeat(40));
  for (const value of ["main", "abcdef1", "a".repeat(39), "g".repeat(40)])
    expect(() => commitIdentity(value)).toThrow();
});
test("confirms every selected skill and rejects partial, failed, or malformed answers", () => {
  expect(installed('[{"name":"code-review","status":"installed"}]', ["code-review"])).toBe(true);
  for (const value of [
    "broken",
    "[]",
    '[{"name":"other","status":"installed"}]',
    '[{"name":"code-review","status":"failed"}]',
    '[{"name":"code-review","status":"skipped"}]',
  ])
    expect(installed(value, ["code-review"])).toBe(false);
});
