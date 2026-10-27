import { expect, test } from "bun:test";
import antiSlop from "./anti-slop/index.ts";
import customTests from "./custom-tests/index.ts";
import operator from "./operator/index.ts";
import { withSkillTopic } from "./skill-topic.ts";

const skillsRoot = new URL("../../.agents/skills/", import.meta.url);
const plugins = { "anti-slop": antiSlop, "custom-tests": customTests, operator };
const pointer = /See ([a-z-]+)\/([a-z-]+\.md)\.$/u;

const messages = Object.entries(plugins).flatMap(([plugin, { rules }]) =>
  Object.entries(rules).flatMap(([rule, { meta }]) =>
    Object.values(meta?.messages ?? {}).map((message) => ({ id: `${plugin}/${rule}`, message })),
  ),
);

test("a message ends with the skill topic pointer", () => {
  expect(withSkillTopic("Parse it.", "lint-fixes/parse-at-the-boundary.md")).toBe(
    "Parse it. See lint-fixes/parse-at-the-boundary.md.",
  );
});

test("every custom rule message points to a linked topic that names the rule", async () => {
  expect(messages.length).toBeGreaterThanOrEqual(14);
  for (const { id, message } of messages) {
    const [, skill, topic] = pointer.exec(message) ?? [];
    expect(topic, `${id}: ${message}`).toBeDefined();
    const router = await Bun.file(new URL(`${skill}/SKILL.md`, skillsRoot)).text();
    expect(router, `${skill}/SKILL.md links ${topic}`).toContain(`](${topic})`);
    const text = await Bun.file(new URL(`${skill}/${topic}`, skillsRoot)).text();
    expect(text, `${skill}/${topic} names ${id}`).toContain(`\`${id}\``);
  }
});

test("each lint-fixes section for a rule shows the fix in code", async () => {
  const fixes = messages.filter(({ message }) => message.includes("See lint-fixes/"));
  expect(fixes.length).toBeGreaterThanOrEqual(13);
  for (const { id, message } of fixes) {
    const [, , topic] = pointer.exec(message) ?? [];
    const text = await Bun.file(new URL(`lint-fixes/${topic}`, skillsRoot)).text();
    const start = text.indexOf(`## \`${id}\``);
    expect(start, `${topic} has a section for ${id}`).toBeGreaterThan(-1);
    const end = text.indexOf("\n## ", start + 1);
    expect(text.slice(start, end === -1 ? undefined : end), id).toContain("```ts");
  }
});
