import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, stat, or recursive removal API.
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type RegistryFake, startRegistryFake } from "./registry-fixture.ts";
import { registryPackage, verifyRegistryInstall } from "./registry-install.ts";

// A small hand-made package stands in for the release, so each answer of the installed command
// is under the test's control and no release build is needed.
let root = "";
let registry: RegistryFake | undefined;
const version = "1.2.3";
const commit = "c".repeat(40);
const identity = "d".repeat(64);
const expected = { artifactIdentity: identity, commit };
const report = JSON.stringify({
  data: { operatorVersion: version, commit, artifactIdentity: identity },
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "registry-install-package-"));
});
afterEach(async () => {
  await registry?.stop();
  registry = undefined;
  await rm(root, { recursive: true, force: true });
});

type Answer = { code?: number; stdout?: string; stderr?: string };

/** Publishes a package whose command records each call and gives the chosen answers. */
async function publish(answers: Record<string, Answer>) {
  const all = {
    "project register --json": {},
    "--version --json": { stdout: report },
    ...answers,
  };
  await Bun.write(
    `${root}/package/package.json`,
    JSON.stringify({ name: registryPackage, version, type: "module" }),
    { createPath: true },
  );
  await Bun.write(
    `${root}/package/cli.js`,
    `import { appendFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2).join(" ");
const { HOME, BUN_INSTALL, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM } = process.env;
const folders = readdirSync(dirname(HOME)).toSorted();
appendFileSync(${JSON.stringify(`${root}/calls`)}, JSON.stringify({ args, cwd: process.cwd(), HOME, BUN_INSTALL, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, folders }) + "\\n");
const answer = ${JSON.stringify(all)}[args] ?? { code: 9 };
process.stdout.write(answer.stdout ?? "");
process.stderr.write(answer.stderr ?? "");
process.exit(answer.code ?? 0);
`,
  );
  const packed = Bun.spawnSync(["tar", "-czf", `${root}/package.tgz`, "-C", root, "package"]);
  expect(packed.exitCode).toBe(0);
  registry = startRegistryFake({
    packageName: registryPackage,
    version,
    tarball: new Uint8Array(await Bun.file(`${root}/package.tgz`).arrayBuffer()),
  });
  return registry;
}

const callSchema = z.object({
  args: z.string(),
  cwd: z.string(),
  HOME: z.string(),
  BUN_INSTALL: z.string(),
  GIT_CONFIG_GLOBAL: z.string(),
  GIT_CONFIG_NOSYSTEM: z.string(),
  folders: z.array(z.string()),
});

async function calls() {
  const text = await Bun.file(`${root}/calls`).text();
  return text
    .trim()
    .split("\n")
    .map((line) => callSchema.parse(JSON.parse(line)));
}

function request(url: string, attempts = 1) {
  return { registry: url, version, expected, attempts, pauseMs: 0 };
}

test("an install that reports the recorded release runs in isolated roots it then removes", async () => {
  const fake = await publish({});
  expect(await verifyRegistryInstall(request(fake.url, 3))).toEqual({
    status: "verified",
    version,
    artifactIdentity: identity,
    attempts: 1,
  });
  expect(fake.requests.filter((one) => one === `/tarball/${version}.tgz`)).toHaveLength(1);
  const made = await calls();
  expect(made.map((call) => call.args)).toEqual(["project register --json", "--version --json"]);
  const isolated = path.dirname(made[0]?.HOME ?? "");
  expect(path.basename(isolated)).toStartWith("operator-registry-install-");
  // The child reads its working folder through every link, such as /var to /private/var on macOS.
  const checkout = path.join(
    await realpath(path.dirname(isolated)),
    path.basename(isolated),
    "checkout",
  );
  for (const call of made)
    expect(call).toEqual({
      args: call.args,
      cwd: checkout,
      HOME: `${isolated}/home`,
      BUN_INSTALL: `${isolated}/bun`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      folders: call.folders,
    });
  expect(await stat(isolated).catch(() => null)).toBeNull();
});

test("a failed first command stops the check and names the command and its last lines", async () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const fake = await publish({ "project register --json": { code: 1, stderr: `${lines}\n` } });
  const result = await verifyRegistryInstall(request(fake.url));
  expect(result.status).toBe("failed");
  const detail = result.status === "failed" ? result.detail : "";
  expect(detail).toStartWith(`${process.execPath} `);
  expect(detail).toEndWith(
    `/cli.js project register --json failed: ${lines.split("\n").slice(-10).join("\n")}`,
  );
  expect((await calls()).map((call) => call.args)).toEqual(["project register --json"]);
});

test("a version report that fails or cannot be read is a failed check", async () => {
  for (const answer of [
    { code: 1, stdout: report },
    { stdout: "not json\nsecond line" },
    {
      stdout: JSON.stringify({ data: { operatorVersion: 5, commit, artifactIdentity: identity } }),
    },
  ]) {
    const fake = await publish({ "--version --json": answer });
    expect(await verifyRegistryInstall(request(fake.url))).toEqual({
      status: "failed",
      detail: `The installed version report could not be read: ${answer.stdout}`,
    });
    await fake.stop();
  }
});

test("each field that differs from the publication is named", async () => {
  const fake = await publish({});
  expect(
    await verifyRegistryInstall({
      ...request(fake.url),
      expected: { artifactIdentity: "e".repeat(64), commit: "f".repeat(40) },
    }),
  ).toEqual({
    status: "mismatch",
    detail: `commit is ${commit}, and the publication recorded ${"f".repeat(40)}. artifactIdentity is ${identity}, and the publication recorded ${"e".repeat(64)}.`,
  });
});

test("a version the registry does not hold names every attempt and the last lines", async () => {
  const fake = await publish({});
  const result = await verifyRegistryInstall({ ...request(fake.url, 2), version: "9.9.9" });
  expect(result.status).toBe("unavailable");
  const detail = result.status === "unavailable" ? result.detail : "";
  expect(detail).toStartWith(
    `bun add -g @fveracoechea/operator@npm:${registryPackage}@9.9.9 failed 2 times: `,
  );
  expect(detail).not.toContain("Stopped by");
  expect(detail.split("\n").length).toBeGreaterThan(1);
  expect(detail).not.toEndWith("\n");
});

test("a retry installs with a new empty cache after a refused first attempt", async () => {
  const fake = await publish({});
  let refused = false;
  // The first manifest request fails, as a registry that has not built the version yet would.
  const front = Bun.serve({
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (!refused && url.pathname !== `/tarball/${version}.tgz`) {
        refused = true;
        return new Response("not yet", { status: 404 });
      }
      return fetch(new URL(`${url.pathname}${url.search}`, fake.url), incoming);
    },
  });
  const started = Date.now();
  try {
    expect(
      await verifyRegistryInstall({
        ...request(`http://127.0.0.1:${front.port}/`, 3),
        pauseMs: 1000,
      }),
    ).toEqual({
      status: "verified",
      version,
      artifactIdentity: identity,
      attempts: 2,
    });
  } finally {
    await front.stop(true);
  }
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect((await calls())[0]?.folders).toContain("cache-2");
});

test("a registry that never answers stops the install at its bound", async () => {
  // The registry answers only after the bound, so a longer bound ends in a plain refusal.
  const stalled = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async () => {
      await Bun.sleep(4000);
      return new Response("late", { status: 404 });
    },
  });
  try {
    const result = await verifyRegistryInstall({
      ...request(`http://127.0.0.1:${stalled.port}/`),
      installTimeoutMs: 1000,
    });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.detail).toEndWith(
      "Stopped by SIGTERM after 1000 ms.",
    );
  } finally {
    await stalled.stop(true);
  }
});
