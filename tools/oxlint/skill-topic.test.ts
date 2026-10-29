import { expect, test } from "bun:test";
import { withSkillTopic } from "./skill-topic.ts";

test("a message ends with the skill topic pointer", () => {
  expect(withSkillTopic("Parse it.", "lint-fixes/parse-at-the-boundary.md")).toBe(
    "Parse it. See lint-fixes/parse-at-the-boundary.md.",
  );
});
