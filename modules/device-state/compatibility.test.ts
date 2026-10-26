import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compatibility } from "./compatibility.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-startup-"));
const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: root,
    XDG_STATE_HOME: `${root}/state`,
    XDG_CONFIG_HOME: `${root}/config`,
    NODE_ENV: "test",
  }),
);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the compatibility owner never creates missing state and preserves corruption with no backup claim", async () => {
  expect(compatibility(paths).tag).toBe("Ok");
  expect(await Bun.file(paths.database).exists()).toBe(false);
  await Bun.write(paths.database, "corrupt", { createPath: true });
  const result = compatibility(paths);
  expect(result.tag).toBe("Err");
  if (result.tag === "Err") {
    expect(result.error.reason).toBe("state_corrupt");
    expect(result.error.detail).toContain("No verified migration backup");
  }
  expect(await Bun.file(paths.database).text()).toBe("corrupt");
});
