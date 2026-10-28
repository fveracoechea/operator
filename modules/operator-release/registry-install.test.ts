import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { startRegistryFake } from "./fake-registry.ts";
import {
  type BuiltRelease,
  installFixture,
  registryPackage,
  sourceRoot,
} from "./install-fixture.ts";
import { OperatorRelease } from "./main.ts";

// The post-publication check against the deterministic registry seam. The release workflow runs
// the same check against the live JSR registry, only after JSR holds the version.
const fixture = await installFixture("registry-install");
let built: BuiltRelease | undefined;

function current() {
  return built ?? expect.unreachable("beforeAll builds the release.");
}

beforeAll(async () => {
  const version = z
    .looseObject({ version: z.string() })
    .parse(await Bun.file(`${sourceRoot}/package.json`).json()).version;
  built = await fixture.release(version, "published");
}, 300_000);

afterAll(async () => {
  await rm(fixture.root, { force: true, recursive: true });
});

function request(registry: string, change: Partial<{ artifactIdentity: string; commit: string }>) {
  const release = current();
  return {
    registry,
    version: release.version,
    expected: { artifactIdentity: release.identity, commit: release.commit, ...change },
    attempts: 1,
    pauseMs: 0,
  };
}

test("a published version that installs and reports the recorded release is verified", async () => {
  const registry = startRegistryFake({ packageName: registryPackage, ...current() });
  try {
    expect(await OperatorRelease.verifyRegistryInstall(request(registry.url, {}))).toEqual({
      status: "verified",
      version: current().version,
      artifactIdentity: current().identity,
      attempts: 1,
    });
    expect(registry.requests).toContain(`/tarball/${current().version}.tgz`);
  } finally {
    await registry.stop();
  }
}, 120_000);

test("an installed release with another identity or commit is a mismatch", async () => {
  const registry = startRegistryFake({ packageName: registryPackage, ...current() });
  try {
    const other = await OperatorRelease.verifyRegistryInstall(
      request(registry.url, { artifactIdentity: "0".repeat(64) }),
    );
    expect(other).toEqual({
      status: "mismatch",
      detail: `artifactIdentity is ${current().identity}, and the publication recorded ${"0".repeat(64)}.`,
    });
    const moved = await OperatorRelease.verifyRegistryInstall(
      request(registry.url, { commit: "1".repeat(40) }),
    );
    expect(moved).toMatchObject({ status: "mismatch" });
    expect(moved.status === "mismatch" && moved.detail).toStartWith(
      `commit is ${current().commit}`,
    );
  } finally {
    await registry.stop();
  }
}, 120_000);

test("a version the registry does not serve yet is retried, then reported unavailable", async () => {
  const registry = startRegistryFake({
    packageName: registryPackage,
    ...current(),
    version: "0.0.0-other",
  });
  try {
    const result = await OperatorRelease.verifyRegistryInstall({
      ...request(registry.url, {}),
      attempts: 2,
    });
    expect(result).toMatchObject({ status: "unavailable" });
    expect(result.status === "unavailable" && result.detail).toContain("failed 2 times");
    expect(
      registry.requests.filter((path) => path === `/${registryPackage}`).length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await registry.stop();
  }
}, 120_000);

test("a registry that never answers stops each attempt at its bound and is unavailable", async () => {
  const asked: string[] = [];
  // The manifest request gets no answer at all, as a stalled connection would.
  const stalled = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(incoming) {
      asked.push(new URL(incoming.url).pathname);
      return Promise.withResolvers<Response>().promise;
    },
  });
  const started = Date.now();
  try {
    const result = await OperatorRelease.verifyRegistryInstall({
      ...request(`http://127.0.0.1:${stalled.port}/`, {}),
      attempts: 2,
      installTimeoutMs: 2000,
    });
    expect(result).toMatchObject({ status: "unavailable" });
    expect(result.status === "unavailable" && result.detail).toContain("failed 2 times");
    expect(result.status === "unavailable" && result.detail).toContain("after 2000 ms");
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(30_000);
  } finally {
    await stalled.stop(true);
  }
}, 60_000);

async function runVerify(args: string[]) {
  const child = Bun.spawn(["bun", "scripts/release.ts", "verify", ...args], {
    cwd: sourceRoot,
    env: Environment.child(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("the release workflow's verify step checks only a JSR publication this commit recorded", async () => {
  const release = current();
  const journal = `${fixture.root}/dist.publication.json`;
  const out = ["--out", `${fixture.root}/dist`, "--attempts", "1", "--pause", "0"];

  const missing = await runVerify(out);
  expect(missing.exitCode, missing.stderr).toBe(0);
  expect(JSON.parse(missing.stdout)).toMatchObject({ status: "nothing_published" });

  await Bun.write(journal, "not json");
  expect((await runVerify(out)).exitCode).toBe(1);

  const record = {
    schemaVersion: 1,
    releaseId: "r".repeat(64),
    version: release.version,
    commit: release.commit,
    artifactIdentity: release.identity,
    paths: {
      jsr: { state: "published", detail: "sent", reference: null, at: "2026-10-28T00:00:00.000Z" },
    },
  };
  await Bun.write(journal, JSON.stringify(record));
  const registry = startRegistryFake({ packageName: registryPackage, ...release });
  try {
    const verified = await runVerify([...out, "--registry", registry.url]);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: "verified" });

    await Bun.write(journal, JSON.stringify({ ...record, commit: "1".repeat(40) }));
    const mismatch = await runVerify([...out, "--registry", registry.url]);
    expect(mismatch.exitCode).toBe(1);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({ status: "mismatch" });
  } finally {
    await registry.stop();
  }
  expect((await runVerify([...out.slice(0, 2), "--attempts", "0"])).exitCode).toBe(2);
}, 240_000);
