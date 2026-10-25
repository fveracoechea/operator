import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { buildArtifact } from "./build.ts";
import { releaseSchema } from "./test-schemas.ts";

const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-build-${crypto.randomUUID()}`;
const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("build follows runtime imports and excludes removed protocols and test fixtures", async () => {
  const result = await buildArtifact({
    sourceRoot,
    artifactRoot: root,
    commit: "a".repeat(40),
    now: "2026-10-24T00:00:00.000Z",
  });
  expect(result.status).toBe("built");
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root }));
  expect(files).toContain("modules/operator-release/manifest.js");
  expect(files).not.toContain("modules/release-publish/main.js");
  expect(
    files.some((file) => /crew-state|project-setup|release-install|\.test\.|fake-/.test(file)),
  ).toBe(false);
  expect(releaseSchema.parse(await Bun.file(`${root}/release.json`).json()).builtAt).toBe(
    "2026-10-24T00:00:00.000Z",
  );
}, 300_000);
