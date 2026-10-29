import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../modules/environment/main.ts";
import { GlobalLauncher } from "../modules/global-launcher/main.ts";
import {
  startPackageRegistry,
  startProxyRecorder,
  writeControlledTools,
} from "./release-fixture.ts";

const script = path.join(import.meta.dir, "release.ts");
const sourceRoot = path.dirname(import.meta.dir);
const clientPath = `${sourceRoot}/node_modules/.bin`;
// No inherited package bin directory may supply a real `jsr` client.
const basePath = Environment.read()
  .PATH.split(":")
  .filter((entry) => !entry.endsWith("/node_modules/.bin"))
  .join(":");
const commit = "c".repeat(40);
let root = "";
let proxy: Awaited<ReturnType<typeof startProxyRecorder>>;
let empty: Awaited<ReturnType<typeof startPackageRegistry>>;
// A run that reaches an install by mistake fails fast against an empty registry.
let bounded: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-release-script-"));
  proxy = await startProxyRecorder();
  empty = await startPackageRegistry("9.9.9", null);
  bounded = ["--registry", empty.url, "--attempts", "1", "--pause", "0"];
});
afterAll(async () => {
  proxy.stop();
  await empty.stop();
  await rm(root, { force: true, recursive: true });
});

/** Runs release.ts in its own process group, with every HTTPS request sent to the recorder. */
async function release(args: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: root,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: Environment.child({
      HOME: `${root}/home`,
      PATH: `${clientPath}:${basePath}`,
      SOURCE_DATE_EPOCH: undefined,
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
      NO_PROXY: "127.0.0.1,localhost",
      ...env,
    }),
  });
  // A child that keeps starting itself is stopped with its whole group.
  const stop = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 10_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(stop);
  return { exitCode, stdout, stderr };
}

/** Builds with a controlled compiler, so the build never depends on the checkout's types. */
async function build(args: string[], epoch: string | undefined) {
  const tools = await writeControlledTools({ bunx: 0 });
  return release(["build", ...args], {
    PATH: `${tools}:${clientPath}:${basePath}`,
    SOURCE_DATE_EPOCH: epoch,
  });
}

function json(text: string) {
  return z.json().parse(JSON.parse(text));
}

function journal(paths: Record<string, unknown>, version = "9.9.9") {
  return JSON.stringify({
    schemaVersion: 1,
    releaseId: "r".repeat(64),
    version,
    commit,
    artifactIdentity: "i".repeat(64),
    paths: Object.fromEntries(
      Object.entries(paths).map(([name, state]) => [
        name,
        { state, detail: "sent", reference: null, at: "2026-10-28T00:00:00.000Z" },
      ]),
    ),
  });
}

async function publishedJournal(): Promise<string[]> {
  const out = await mkdtemp(path.join(root, "verify-"));
  await Bun.write(`${out}/dist.publication.json`, journal({ jsr: "published" }));
  return ["--out", `${out}/dist`];
}

test("refuses an unknown operation and names the operations", async () => {
  const result = await release(["unknown"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("release: the operations are `build`, `launcher`");
});

test("writes the Nix launcher only for an absolute root and an absolute Bun", async () => {
  const installRoot = "/nix/store/x-operator/lib/operator";
  const bun = "/nix/store/y-bun/bin/bun";
  const written = await release(["launcher", "--root", installRoot, "--bun", bun]);
  expect(written).toEqual({
    exitCode: 0,
    stdout: GlobalLauncher.nixText({ installRoot, bun }),
    stderr: "",
  });
  for (const named of [
    ["--bun", bun],
    ["--root", installRoot],
    ["--root", "lib/operator", "--bun", bun],
    ["--root", installRoot, "--bun", "bin/bun"],
  ]) {
    const refused = await release(["launcher", ...named]);
    expect({ exitCode: refused.exitCode, stdout: refused.stdout }, named.join(" ")).toEqual({
      exitCode: 2,
      stdout: "",
    });
    expect(refused.stderr).toContain("--root");
  }
});

test("refuses a build without one full commit and writes nothing", async () => {
  for (const named of [
    [],
    ["--commit", "c".repeat(39)],
    ["--commit", "c".repeat(41)],
    ["--commit", `x${commit}`],
    ["--commit", `${commit}x`],
    ["--commit", "C".repeat(40)],
  ]) {
    const out = `${root}/build-${crypto.randomUUID()}`;
    const result = await build(["--out", out, ...named], "1761523200");
    expect(result.exitCode, named.join(" ")).toBe(2);
    expect(result.stderr).toContain("--commit");
    expect(await stat(out).catch(() => null)).toBeNull();
  }
});

test("refuses a build without a commit time in whole seconds and writes nothing", async () => {
  for (const epoch of [undefined, "", "-1", "1e3", "1 ", "10000000000000"]) {
    const out = `${root}/build-${crypto.randomUUID()}`;
    const result = await build(["--out", out, "--commit", commit], epoch);
    expect(result.exitCode, String(epoch)).toBe(2);
    expect(result.stderr).toContain("SOURCE_DATE_EPOCH");
    expect(await stat(out).catch(() => null)).toBeNull();
  }
});

test("verifies nothing when this commit recorded no JSR publication", async () => {
  const out = await mkdtemp(path.join(root, "verify-"));
  const nothing = {
    status: "nothing_published",
    detail: "This commit recorded no JSR publication.",
  };
  const missing = await release(["verify", "--out", `${out}/dist`, ...bounded]);
  expect({ exitCode: missing.exitCode, report: json(missing.stdout) }).toEqual({
    exitCode: 0,
    report: nothing,
  });

  for (const paths of [{ "github-source": "published" }, { jsr: "failed" }]) {
    await Bun.write(`${out}/dist.publication.json`, journal(paths));
    const unsent = await release(["verify", "--out", `${out}/dist`, ...bounded]);
    expect({ exitCode: unsent.exitCode, report: json(unsent.stdout) }).toEqual({
      exitCode: 0,
      report: nothing,
    });
  }

  await Bun.write(`${out}/dist.publication.json`, "not json");
  const unreadable = await release(["verify", "--out", `${out}/dist`, ...bounded]);
  expect({ exitCode: unreadable.exitCode, report: json(unreadable.stdout) }).toEqual({
    exitCode: 1,
    report: nothing,
  });
  expect(proxy.hosts).toEqual([]);
});

test("refuses verify attempts below one or a pause below zero", async () => {
  const out = await publishedJournal();
  for (const named of [
    ["--registry", empty.url, "--attempts", "0", "--pause", "0"],
    ["--registry", empty.url, "--attempts", "1.5", "--pause", "0"],
    ["--registry", empty.url, "--attempts", "1", "--pause", "-1"],
    ["--registry", empty.url, "--attempts", "1", "--pause", "0.5"],
  ]) {
    const refused = await release(["verify", ...out, ...named]);
    expect({ exitCode: refused.exitCode, stdout: refused.stdout }, named.join(" ")).toEqual({
      exitCode: 2,
      stdout: "",
    });
    expect(refused.stderr).toContain("--attempts");
  }
});

test("checks the artifact with the jsr client on the path and reports its result", async () => {
  const artifact = `${root}/check-artifact`;
  await Bun.write(`${artifact}/jsr.json`, "{}");
  const accepting = await writeControlledTools({ bun: 0, jsr: 0 });
  const accepted = await release(["check", "--out", artifact], {
    PATH: `${accepting}:${clientPath}:${basePath}`,
  });
  expect(accepted.exitCode).toBe(0);
  expect(z.object({ status: z.string() }).parse(JSON.parse(accepted.stdout)).status).toBe(
    "succeeded",
  );
  expect(await Bun.file(`${accepting}/jsr.args`).text()).toBe("publish --dry-run\n");

  const refusing = await writeControlledTools({ bun: 0, jsr: 1 });
  const refused = await release(["check", "--out", artifact], {
    PATH: `${refusing}:${clientPath}:${basePath}`,
  });
  expect(refused.exitCode).toBe(1);
  expect(z.object({ status: z.string() }).parse(JSON.parse(refused.stdout)).status).toBe("failed");
});

test("re-enters with the pinned client directory first on a child-only PATH", async () => {
  const artifact = `${root}/reentry-artifact`;
  await Bun.write(`${artifact}/jsr.json`, "{}");
  // The controlled install fails, so no client runs at all.
  const tools = await writeControlledTools({ bun: 1, jsr: 0 });
  const path = `${tools}:${basePath}`;
  const result = await release(["check", "--out", artifact], { PATH: path });
  expect(result.exitCode).toBe(1);
  expect(z.object({ code: z.string() }).parse(JSON.parse(result.stdout)).code).toBe(
    "dependencies_unavailable",
  );
  expect(await Bun.file(`${tools}/bun.path`).text()).toBe(`${clientPath}:${path}\n`);
  expect(await Bun.file(`${tools}/jsr.args`).exists()).toBe(false);

  const refused = await release(["unknown"], { PATH: path });
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr).toContain("release: the operations are");
});

test("verify retries a missing version with the pause in seconds, then reports it unavailable", async () => {
  const registry = await startPackageRegistry("9.9.9", null);
  try {
    const out = await publishedJournal();
    const once = await release([
      "verify",
      ...out,
      "--registry",
      registry.url,
      "--attempts",
      "1",
      "--pause",
      "0",
    ]);
    expect(once.exitCode).toBe(1);
    expect(z.object({ status: z.string() }).parse(JSON.parse(once.stdout)).status).toBe(
      "unavailable",
    );
    const manifests = registry.requests.length;
    expect(manifests).toBeGreaterThan(0);
    expect(registry.requests[0]).toBe("/@jsr/fveracoechea__operator");

    const twice = await release([
      "verify",
      ...out,
      "--registry",
      registry.url,
      "--attempts",
      "2",
      "--pause",
      "4",
    ]);
    expect(twice.exitCode).toBe(1);
    expect(registry.requests.length).toBe(manifests * 3);
    // The second attempt starts only after the pause, which is given in seconds. A pause read as
    // milliseconds leaves only the install start-up time between the attempts.
    const gap = (registry.times[manifests * 2] ?? 0) - (registry.times[manifests * 2 - 1] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(4000);
  } finally {
    await registry.stop();
  }
});

test("verify installs from the JSR npm registry by default", async () => {
  const out = await publishedJournal();
  const result = await release(["verify", ...out, "--attempts", "1", "--pause", "0"]);
  expect(result.exitCode).toBe(1);
  expect(new Set(proxy.hosts)).toEqual(new Set(["npm.jsr.io:443"]));
});

test("verify reports an installed release that names this publication as verified", async () => {
  const out = await publishedJournal();
  const matching = await startPackageRegistry("9.9.9", {
    operatorVersion: "9.9.9",
    commit,
    artifactIdentity: "i".repeat(64),
  });
  try {
    // Neither --attempts nor --pause is needed when the first install verifies.
    const verified = await release(["verify", ...out, "--registry", matching.url]);
    expect({ exitCode: verified.exitCode, report: json(verified.stdout) }).toEqual({
      exitCode: 0,
      report: {
        status: "verified",
        version: "9.9.9",
        artifactIdentity: "i".repeat(64),
        attempts: 1,
      },
    });
  } finally {
    await matching.stop();
  }

  const other = await startPackageRegistry("9.9.9", {
    operatorVersion: "9.9.9",
    commit: "1".repeat(40),
    artifactIdentity: "i".repeat(64),
  });
  try {
    const mismatch = await release(["verify", ...out, "--registry", other.url]);
    expect(mismatch.exitCode).toBe(1);
    expect(z.object({ status: z.string() }).parse(JSON.parse(mismatch.stdout)).status).toBe(
      "mismatch",
    );
  } finally {
    await other.stop();
  }
}, 60_000);

test("builds with the commit time as the build time and checks the artifact", async () => {
  const out = `${root}/build-complete`;
  // The controlled compiler emits no declarations, so the artifact is incomplete.
  const result = await build(["--out", out, "--commit", commit], "1761523200");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("release: the artifact is missing cli.d.ts");
  const recorded = z
    .object({ builtAt: z.string(), commit: z.string() })
    .parse(await Bun.file(`${out}/release.json`).json());
  expect({ builtAt: recorded.builtAt, commit: recorded.commit }).toEqual({
    builtAt: "2025-10-27T00:00:00.000Z",
    commit,
  });
});
