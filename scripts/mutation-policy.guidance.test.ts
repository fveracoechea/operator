import { expect, test } from "bun:test";
// Bun has no path manipulation API.
import path from "node:path";
import { mutationGuidance } from "./mutation-policy.ts";

test("the summary points to an existing topic that explains survivor repairs", async () => {
  const topic = Bun.file(path.join(import.meta.dir, "..", mutationGuidance));
  expect(await topic.exists()).toBe(true);
  const text = await topic.text();
  for (const required of [
    "## Survivors",
    "beside-test",
    "equivalent:",
    "no rule:",
    "bun run mutate",
    "exit 2",
  ]) {
    expect(text).toContain(required);
  }
});
