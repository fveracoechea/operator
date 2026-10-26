import { expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { runSkills } from "./skills.ts";
// Bun has no platform temporary-root API.
import { tmpdir } from "node:os";

test("rejects unsupported, duplicate, and target-free flags before installation", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${tmpdir()}/unused-skill-parser`, NODE_ENV: "test" }),
  );
  for (const args of [
    ["other"],
    ["install"],
    ["install", "--claude", "--claude"],
    ["install", "--claude", "--force"],
    ["install", "--check"],
  ])
    expect(await runSkills(args, paths, true)).toBe(false);
});
