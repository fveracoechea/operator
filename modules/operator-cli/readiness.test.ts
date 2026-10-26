import { expect, test } from "bun:test";
// Bun has no platform temporary-root API.
import { tmpdir } from "node:os";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { runReadiness } from "./readiness.ts";

test("unsupported readiness flags refuse before any observation", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${tmpdir()}/unused-ready-parser`, NODE_ENV: "test" }),
  );
  for (const args of [
    ["other"],
    ["ready", "--json", "--json"],
    ["ready", "--probe"],
    ["ready", "--host", "opencode"],
  ])
    expect(await runReadiness(args, paths, true)).toBe(false);
});
