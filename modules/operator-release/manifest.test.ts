import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no recursive directory removal or symlink API.
import { rm, symlink } from "node:fs/promises";
import { readArtifactRelease, readReleaseManifest } from "./manifest.ts";

const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-manifest-${crypto.randomUUID()}`;
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

test("the default running-package root decodes escaped URL path characters", async () => {
  const installed = `${root}/package with spaces #identity`;
  for (const file of ["manifest.ts", "inventory.ts"])
    await Bun.write(
      `${installed}/modules/operator-release/${file}`,
      Bun.file(new URL(file, import.meta.url)),
      { createPath: true },
    );
  await symlink(
    Bun.fileURLToPath(new URL("../../node_modules", import.meta.url)),
    `${installed}/node_modules`,
  );
  await Bun.write(`${installed}/package.json`, '{"version":"3.2.1","engines":{"bun":">=1.4.0"}}');
  const copied = (await import(
    Bun.pathToFileURL(`${installed}/modules/operator-release/manifest.ts`).href
  )) as typeof import("./manifest.ts");
  expect(await copied.readReleaseManifest()).toMatchObject({
    version: "3.2.1",
    supportedBun: ">=1.4.0",
  });
});
