import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { scanArtifact } from "./pack.ts";

const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-pack-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("registry entries retain bytes, prefix, and the CLI executable flag", async () => {
  await Bun.write(`${root}/cli.js`, new Uint8Array([0, 255]), { createPath: true });
  await Bun.write(`${root}/nested/data`, "text", { createPath: true });
  expect(await scanArtifact(`${root}/`, "package")).toEqual([
    { path: "package/cli.js", bytes: new Uint8Array([0, 255]), executable: true },
    { path: "package/nested/data", bytes: new TextEncoder().encode("text"), executable: false },
  ]);
  expect((await scanArtifact(root, ""))[0]?.path).toBe("cli.js");
});
