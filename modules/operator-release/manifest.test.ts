import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { readArtifactRelease, readReleaseManifest } from "./manifest.ts";

const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-manifest-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("source metadata comes from its package while built metadata survives registry rewriting", async () => {
  await Bun.write(
    `${root}/package.json`,
    JSON.stringify({ version: "1.2.3", engines: { bun: ">=1.4.0" } }),
    { createPath: true },
  );
  expect(await readReleaseManifest(root)).toMatchObject({
    version: "1.2.3",
    supportedBun: ">=1.4.0",
    commit: null,
  });
  await Bun.write(
    `${root}/release.json`,
    JSON.stringify({
      version: "2.0.0",
      supportedBun: ">=1.4.2",
      commit: "a".repeat(40),
      artifactIdentity: "content",
      builtAt: "time",
    }),
  );
  expect(await readReleaseManifest(root)).toEqual({
    version: "2.0.0",
    supportedBun: ">=1.4.2",
    commit: "a".repeat(40),
    artifactIdentity: "content",
    builtAt: "time",
  });
});

test("artifact inspection never guesses its version from a package manifest", async () => {
  await Bun.write(`${root}/package.json`, '{"version":"9.0.0"}', { createPath: true });
  expect(await readArtifactRelease(root)).toEqual({ version: "0.0.0", commit: null });
  await Bun.write(`${root}/release.json`, '{"version":42}');
  await expect(readArtifactRelease(root)).rejects.toThrow("version as something other than text");
});
