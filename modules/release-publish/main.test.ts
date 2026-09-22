import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { OperatorRelease } from "../operator-release/main.ts";
import type { ReleaseFakeState } from "./fake-publish-state.ts";
import { type JsrFake, startJsrFake } from "./fake-jsr.ts";
import { ReleasePublish } from "./main.ts";

const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const fakeGhPath = new URL("./fake-gh.ts", import.meta.url).pathname;

const COMMIT = "1".repeat(40);
const OTHER_COMMIT = "2".repeat(40);

const roots: string[] = [];
const fakes: JsrFake[] = [];
let artifactRoot = "";
let ghDirectory = "";
let binDirectory = "";
let journalPath = "";
let version = "";

const inheritedPath = process.env.PATH ?? "";

afterEach(async () => {
  process.env.PATH = inheritedPath;
  for (const fake of fakes.splice(0)) {
    fake.stop();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** The path a publication runs with. The real `gh` is dropped, so no test can reach it. */
function fixturePath(): string {
  const inherited = inheritedPath.split(":").filter((one) => one.length > 0);
  const kept = inherited.filter((directory) => Bun.which("gh", { PATH: directory }) === null);
  return [binDirectory, ...kept].join(":");
}

async function seedGithub(state: Partial<ReleaseFakeState>): Promise<void> {
  await Bun.write(
    `${ghDirectory}/state.json`,
    `${JSON.stringify({ compare: {}, checkRuns: {}, tags: {}, releases: {}, ...state })}\n`,
  );
}

async function seedFault(name: string, kind: string, remaining = 1): Promise<void> {
  await Bun.write(
    `${ghDirectory}/faults.json`,
    `${JSON.stringify({ [name]: { kind, remaining } })}\n`,
  );
}

beforeEach(async () => {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-publish-${crypto.randomUUID()}`;
  roots.push(root);
  artifactRoot = `${root}/artifact`;
  ghDirectory = `${root}/gh`;
  binDirectory = `${root}/bin`;
  journalPath = `${root}/publication.json`;

  await Bun.$`mkdir -p ${ghDirectory} ${binDirectory}`.quiet();
  // The fake carries its own directory, so nothing depends on the environment of the caller.
  await Bun.write(
    `${binDirectory}/gh`,
    `#!/bin/sh\nRELEASE_GH_DIR=${ghDirectory} exec bun ${fakeGhPath} "$@"\n`,
  );
  await Bun.$`chmod +x ${binDirectory}/gh`.quiet();
  process.env.PATH = fixturePath();

  await OperatorRelease.build({ sourceRoot, artifactRoot, commit: COMMIT });
  version = (await Bun.file(`${artifactRoot}/release.json`).json()).version;

  await seedGithub({
    compare: { [COMMIT]: "behind", [OTHER_COMMIT]: "diverged" },
    checkRuns: { [COMMIT]: [{ name: "Quality", conclusion: "success" }] },
  });
});

function jsrFake(options: Parameters<typeof startJsrFake>[0] = {}): JsrFake {
  const fake = startJsrFake(options);
  fakes.push(fake);
  return fake;
}

type PublishRequest = Parameters<typeof ReleasePublish.publish>[0];

function request(fake: JsrFake, extra: Partial<PublishRequest> = {}): PublishRequest {
  return {
    artifactRoot,
    commit: COMMIT,
    base: "main",
    repository: "fveracoechea/operator",
    journalPath,
    jsr: { api: fake.api, scope: "fveracoechea", package: "operator", fetch: fake.fetch },
    environment: fake.environment,
    waitMs: 1,
    approvedReleaseId: undefined,
    ...extra,
  };
}

describe("the release plan", () => {
  test("binds one approval to the exact version, commit, and published bytes", async () => {
    const fake = jsrFake();

    const first = await ReleasePublish.plan(request(fake));
    const second = await ReleasePublish.plan(request(fake));

    expect(first.releaseId).toBe(second.releaseId);
    expect(first.blockers).toEqual([]);
    expect(first.commit).toBe(COMMIT);
    expect(first.tag).toBe(`v${version}`);
  });

  test("makes changed content a different release", async () => {
    const fake = jsrFake();
    const before = await ReleasePublish.plan(request(fake));

    await Bun.write(`${artifactRoot}/skills/operator/SKILL.md`, "changed\n");
    const after = await ReleasePublish.plan(request(fake));

    expect(after.releaseId).not.toBe(before.releaseId);
  });

  test("refuses a commit that is not merged into the release branch", async () => {
    const fake = jsrFake();

    const plan = await ReleasePublish.plan(request(fake, { commit: OTHER_COMMIT }));

    expect(plan.blockers.map((one) => one.reason)).toContain("commit_not_merged");
  });

  test("refuses a commit whose checks did not pass", async () => {
    await seedGithub({
      compare: { [COMMIT]: "behind" },
      checkRuns: { [COMMIT]: [{ name: "Quality", conclusion: "failure" }] },
    });
    const fake = jsrFake();

    const plan = await ReleasePublish.plan(request(fake));

    expect(plan.blockers.map((one) => one.reason)).toContain("checks_contradicted");
  });

  test("refuses a commit with no recorded check at all", async () => {
    await seedGithub({ compare: { [COMMIT]: "behind" }, checkRuns: {} });
    const fake = jsrFake();

    const plan = await ReleasePublish.plan(request(fake));

    expect(plan.blockers.map((one) => one.reason)).toContain("checks_unproven");
  });

  test("refuses to move a tag that already names another commit", async () => {
    await seedGithub({
      compare: { [COMMIT]: "behind" },
      checkRuns: { [COMMIT]: [{ name: "Quality", conclusion: "success" }] },
      tags: { [`v${version}`]: OTHER_COMMIT },
    });
    const fake = jsrFake();

    const plan = await ReleasePublish.plan(request(fake));

    expect(plan.blockers.map((one) => one.reason)).toContain("tag_moved");
  });

  test("refuses to replace a version the registry already holds", async () => {
    const fake = jsrFake({ published: [version] });

    const plan = await ReleasePublish.plan(request(fake));

    expect(plan.blockers.map((one) => one.reason)).toContain("version_published");
  });
});

describe("the publication", () => {
  test("refuses to publish without an approval for this exact release", async () => {
    const fake = jsrFake();

    const result = await ReleasePublish.publish(request(fake, { approvedReleaseId: undefined }));

    expect(result.status).toBe("approval-required");
    expect(fake.received).toEqual([]);
  });

  test("refuses an approval granted against different content", async () => {
    const fake = jsrFake();

    const result = await ReleasePublish.publish(
      request(fake, { approvedReleaseId: "0".repeat(64) }),
    );

    expect(result.status).toBe("approval-stale");
    expect(fake.received).toEqual([]);
  });

  test("delivers both paths from one approved commit", async () => {
    const fake = jsrFake();
    const plan = await ReleasePublish.plan(request(fake));

    const result = await ReleasePublish.publish(
      request(fake, { approvedReleaseId: plan.releaseId }),
    );

    expect(result.status).toBe("published");
    expect(fake.received[0]).toMatchObject({ version, config: "/jsr.json" });
    expect(fake.received[0]?.authorization).toStartWith("githuboidc ");
    const state: ReleaseFakeState = await Bun.file(`${ghDirectory}/state.json`).json();
    expect(state.tags[`v${version}`]).toBe(COMMIT);
    expect(state.releases[`v${version}`]).toContain(`v${version}`);
  });

  test("uses no credential of its own when the runner offers no short-lived one", async () => {
    const fake = jsrFake();
    const plan = await ReleasePublish.plan(request(fake));

    const result = await ReleasePublish.publish(
      request(fake, {
        approvedReleaseId: plan.releaseId,
        environment: { JSR_TOKEN: "a-personal-token-that-must-not-be-used" },
      }),
    );

    expect(result.status).toBe("partial");
    expect(fake.received).toEqual([]);
    const delivered = await ReleasePublish.delivered({ journalPath });
    expect(delivered.state === "read" && delivered.journal.paths.jsr?.state).toBe("failed");
  });

  test("keeps the delivered path and retries only the missing one", async () => {
    const fake = jsrFake({ createStatus: 400 });
    const plan = await ReleasePublish.plan(request(fake));

    const first = await ReleasePublish.publish(
      request(fake, { approvedReleaseId: plan.releaseId }),
    );
    expect(first.status).toBe("partial");
    expect(first.status === "partial" && first.journal.paths["github-source"]?.state).toBe(
      "published",
    );

    const retryFake = jsrFake();
    const retryPlan = await ReleasePublish.plan(request(retryFake));
    expect(retryPlan.releaseId).toBe(plan.releaseId);
    const second = await ReleasePublish.publish(
      request(retryFake, { approvedReleaseId: plan.releaseId }),
    );

    expect(second.status).toBe("published");
    // The source path was already delivered, so the retry sent no second tag request.
    const calls = await Bun.file(`${ghDirectory}/calls.log`).text();
    expect(calls.split("\n").filter((line) => line.includes("git/refs")).length).toBe(1);
    expect(retryFake.received.length).toBe(1);
  });

  test("refuses a retry that would send different content under the same version", async () => {
    const fake = jsrFake({ createStatus: 400 });
    const plan = await ReleasePublish.plan(request(fake));
    await ReleasePublish.publish(request(fake, { approvedReleaseId: plan.releaseId }));

    await Bun.write(`${artifactRoot}/skills/operator/SKILL.md`, "changed\n");
    const retry = await ReleasePublish.publish(
      request(jsrFake(), { approvedReleaseId: plan.releaseId }),
    );

    expect(retry.status).toBe("blocked");
    expect(retry.status === "blocked" && retry.plan.blockers.map((one) => one.reason)).toContain(
      "artifact_changed",
    );
  });

  test("leaves an unfinished registry answer uncertain instead of assuming it landed", async () => {
    const fake = jsrFake({ pendingReadings: 5 });
    const plan = await ReleasePublish.plan(request(fake));

    const result = await ReleasePublish.publish(
      request(fake, { approvedReleaseId: plan.releaseId, attempts: 2, waitMs: 1 }),
    );

    expect(result.status).toBe("partial");
    const delivered = await ReleasePublish.delivered({ journalPath });
    expect(delivered.state === "read" && delivered.journal.paths.jsr?.state).toBe("uncertain");
  });

  test("leaves a faulted tag write uncertain rather than repeating it", async () => {
    await seedFault("create_tag", "server_error");
    const fake = jsrFake();
    const plan = await ReleasePublish.plan(request(fake));

    const result = await ReleasePublish.publish(
      request(fake, { approvedReleaseId: plan.releaseId }),
    );

    expect(result.status).toBe("partial");
    const delivered = await ReleasePublish.delivered({ journalPath });
    expect(delivered.state === "read" && delivered.journal.paths["github-source"]?.state).toBe(
      "uncertain",
    );
  });
});

describe("the published artifact", () => {
  test("packs every byte of the artifact into one gzipped tarball", async () => {
    const packed = await ReleasePublish.pack({ artifactRoot });

    const extracted = `${artifactRoot}-extracted`;
    roots.push(extracted);
    await Bun.$`mkdir -p ${extracted}`.quiet();
    await Bun.write(`${extracted}/artifact.tgz`, packed.bytes);
    await Bun.$`tar -xzf ${extracted}/artifact.tgz -C ${extracted}`.quiet();

    expect(await Bun.file(`${extracted}/cli.js`).text()).toBe(
      await Bun.file(`${artifactRoot}/cli.js`).text(),
    );
    expect(await Bun.file(`${extracted}/skills/operator/SKILL.md`).exists()).toBe(true);
    expect(await Bun.file(`${extracted}/jsr.json`).exists()).toBe(true);
  });

  test("packs the same bytes every time, so a retry sends what was approved", async () => {
    const first = await ReleasePublish.pack({ artifactRoot });
    const second = await ReleasePublish.pack({ artifactRoot });

    expect(second.identity).toBe(first.identity);
  });
});
