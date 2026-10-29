import { expect, test } from "bun:test";
import { z } from "zod";
import { commitIdentity, installed, roster } from "./catalog.ts";

test("selects every distinct non-owned name, including cursor and unslop", () => {
  const documents = ["code-review", "bun", "cursor", "unslop", "super-agent", "code-review"].map(
    (name) => `---\nname: ${name}\ndescription: A skill.\n---\n`,
  );
  expect(roster(documents, ["Bun", "super-agent"])).toEqual(["code-review", "cursor", "unslop"]);
});
test("reads only the leading frontmatter block in LF or CRLF form", () => {
  const long = `a${"b".repeat(63)}`;
  expect(
    roster(
      [
        "---\r\nname: crlf\r\n---\r\nbody",
        "---\nname: bare\n---",
        "---\nname: lazy\n---\nbody\n---\nmore",
        "---\nname: a\n---\n",
        `---\nname: ${long}\n---\n`,
        "---\nname: x1-y\n---\n",
      ],
      [],
    ),
  ).toEqual(["a", long, "bare", "crlf", "lazy", "x1-y"]);
});
test.each([
  "no frontmatter",
  "body\n---\nname: late\n---\n",
  "---\nname: ../escape\n---\n",
  "---\nname: --all\n---\n",
  "---\nname: '*'\n---\n",
  "---\nname: code review\n---\n",
  "---\nname: Upper\n---\n",
  "---\nname: 1digit\n---\n",
  `---\nname: a${"b".repeat(64)}\n---\n`,
  "---\ndescription: missing name\n---\n",
])("rejects invalid roster input %s rather than broaden installer scope", (document) => {
  expect(() => roster([document], [])).toThrow(z.ZodError);
});
test("accepts only a full resolved commit", () => {
  expect(commitIdentity(`${"a".repeat(40)}\n`)).toBe("a".repeat(40));
  expect(commitIdentity(`0123456789abcdef${"f".repeat(24)}`)).toBe(
    `0123456789abcdef${"f".repeat(24)}`,
  );
  for (const value of [
    "main",
    "abcdef1",
    "a".repeat(39),
    "a".repeat(41),
    `x${"a".repeat(40)}`,
    "g".repeat(40),
  ])
    expect(() => commitIdentity(value)).toThrow();
});
test("confirms every selected skill and rejects partial, failed, or malformed answers", () => {
  expect(installed('[{"name":"code-review","status":"installed"}]', ["code-review"])).toBe(true);
  const both =
    '[{"name":"code-review","status":"installed"},{"name":"other","status":"installed"}]';
  expect(installed(both, ["code-review"])).toBe(true);
  expect(installed(both, ["code-review", "missing"])).toBe(false);
  for (const value of [
    "broken",
    "[]",
    '{"name":"code-review","status":"installed"}',
    '[{"name":"other","status":"installed"}]',
    '[{"name":"code-review","status":"failed"}]',
    '[{"name":"code-review","status":"skipped"}]',
  ])
    expect(installed(value, ["code-review"])).toBe(false);
});
