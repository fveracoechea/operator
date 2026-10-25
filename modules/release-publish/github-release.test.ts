import { afterEach, expect, test } from "bun:test";
// Bun has no chmod or recursive directory removal API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { releaseFakeStateSchema } from "./fake-publish-state.ts";

const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-github-release-${crypto.randomUUID()}`;
const modulePath = new URL("./github-release.ts", import.meta.url).pathname;
const fakePath = new URL("./fake-gh.ts", import.meta.url).pathname;
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("release operations use the tool boundary for tag creation and merge observations", async () => {
  await Bun.write(
    `${root}/state.json`,
    JSON.stringify({ compare: { wanted: "behind", other: "diverged" }, tags: {}, releases: {} }),
    { createPath: true },
  );
  await Bun.write(`${root}/bin/gh`, `#!/bin/sh\nexec ${process.execPath} ${fakePath} "$@"\n`, {
    createPath: true,
  });
  await chmod(`${root}/bin/gh`, 0o755);
  const code = `
const api = await import(${JSON.stringify(modulePath)});
const common = { repository: "test/repo", tag: "v1" };
const results = [
  await api.readMerged({ ...common, base: "main", commit: "wanted" }),
  await api.readMerged({ ...common, base: "main", commit: "other" }),
  await api.readTag(common),
  await api.createTag({ ...common, commit: "wanted" }),
  await api.readTag(common),
  await api.readRelease(common),
  await api.createRelease({ ...common, name: "Release", body: "notes" }),
  await api.readRelease(common),
];
console.log(JSON.stringify(results));`;
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: {
      ...process.env,
      PATH: `${root}/bin`,
      HOME: root,
      RELEASE_GH_DIR: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).json().then((value: unknown) => z.unknown().parse(value)),
  ]);
  expect(exit).toBe(0);
  expect(output).toMatchObject([
    { status: "merged" },
    { status: "not-merged" },
    { status: "absent" },
    { status: "succeeded" },
    { status: "present", sha: "wanted" },
    { status: "absent" },
    { status: "succeeded" },
    { status: "present" },
  ]);
  expect(
    releaseFakeStateSchema.parse(await Bun.file(`${root}/state.json`).json()).releaseBodies?.v1,
  ).toBe("notes");
});
