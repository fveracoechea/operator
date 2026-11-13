// Rule messages remain useful in a mutation sandbox without any installed skills.
import { expect, test } from "bun:test";
import antiSlop from "./anti-slop/index.ts";
import customTests from "./custom-tests/index.ts";
import operator from "./operator/index.ts";

const docsRoot = new URL("../../docs/agents/", import.meta.url);
const plugins = { "anti-slop": antiSlop, "custom-tests": customTests, operator };
const pointer = /See docs\/agents\/([a-z-]+)\/([a-z-]+\.md)\.$/u;

const messages = Object.entries(plugins).flatMap(([plugin, { rules }]) =>
  Object.entries(rules).flatMap(([rule, { meta }]) =>
    Object.values(meta?.messages ?? {}).map((message) => ({ id: `${plugin}/${rule}`, message })),
  ),
);

test("every custom rule message points to a documentation topic that names the rule", async () => {
  expect(messages.length).toBeGreaterThanOrEqual(14);
  for (const { id, message } of messages) {
    const [, directory, topic] = pointer.exec(message) ?? [];
    expect(topic, `${id}: ${message}`).toBeDefined();
    const text = await Bun.file(new URL(`${directory}/${topic}`, docsRoot)).text();
    expect(text, `${directory}/${topic} names ${id}`).toContain(`\`${id}\``);
  }
});

test("each lint-fixes section for a rule shows the fix in code", async () => {
  const fixes = messages.filter(({ message }) => message.includes("See docs/agents/lint-fixes/"));
  expect(fixes.length).toBeGreaterThanOrEqual(13);
  for (const { id, message } of fixes) {
    const [, , topic] = pointer.exec(message) ?? [];
    const text = await Bun.file(new URL(`lint-fixes/${topic}`, docsRoot)).text();
    const start = text.indexOf(`## \`${id}\``);
    expect(start, `${topic} has a section for ${id}`).toBeGreaterThan(-1);
    const end = text.indexOf("\n## ", start + 1);
    expect(text.slice(start, end === -1 ? undefined : end), id).toContain("```ts");
  }
});
