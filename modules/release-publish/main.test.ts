import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { OperatorRelease } from "../operator-release/main.ts";
import type { ReleaseFakeState } from "./fake-publish-state.ts";
import { type JsrFake, type JsrFakeOptions, startJsrFake } from "./fake-jsr.ts";
import { ReleasePublish } from "./main.ts";

const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const fakeGhPath = new URL("./fake-gh.ts", import.meta.url).pathname;

// Every test publishes a real artifact, and building one compiles the whole release. That takes
// far longer than a default test, and longer again on a CI runner.
setDefaultTimeout(300_000);

const COMMIT = "1".repeat(40);
const OTHER_COMMIT = "2".repeat(40);

const roots: string[] = [];
const fakes: JsrFake[] = [];
let root = "";
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

/**
 * The path a publication runs with.
 * The fake comes first, so a call reaches it and never the `gh` this machine installed. The
 * rest of the path stays: dropping every directory that holds a real `gh` would drop the tools
 * beside it, and on a GitHub runner that is all of `/usr/bin`.
 */
function fixturePath(): string {
  const inherited = inheritedPath.split(":").filter((one) => one.length > 0);
  return [binDirectory, ...inherited].join(":");
}

async function seedGithub(state: Partial<ReleaseFakeState>): Promise<void> {
  await Bun.write(
    `${ghDirectory}/state.json`,
    `${JSON.stringify({ compare: {}, tags: {}, releases: {}, ...state })}\n`,
  );
}

async function seedFault(name: string, kind: string, remaining = 1): Promise<void> {
  await Bun.write(
    `${ghDirectory}/faults.json`,
    `${JSON.stringify({ [name]: { kind, remaining } })}\n`,
  );
}

beforeEach(async () => {
  root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-publish-${crypto.randomUUID()}`;
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
  });
});

async function jsrFake(options: JsrFakeOptions = {}): Promise<JsrFake> {
  const fake = await startJsrFake({
    directory: `${root}/jsr-${fakes.length}`,
    binDirectory,
    ...options,
  });
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
    ...extra,
  };
}

describe("the release plan", () => {
  test("binds one release identity to the exact version, commit, and published bytes", async () => {
    const fake = await jsrFake();

    const first = await ReleasePublish.plan(request(fake));
    const second = await ReleasePublish.plan(request(fake));

    expect(first.releaseId).toBe(second.releaseId);
    expect(first.blockers).toEqual([]);
    expect(first.commit).toBe(COMMIT);
    expect(first.tag).toBe(`v${version}`);
  });

  test("makes changed content a different release", async () => {
    const fake = await jsrFake();
    const before = await ReleasePublish.plan(request(fake));

    await Bun.write(`${artifactRoot}/skills/operator/SKILL.md`, "changed\n");
    const after = await ReleasePublish.plan(request(fake));

    expect(after.releaseId).not.toBe(before.releaseId);
  });

  test("refuses a commit that is not merged into the release branch", async () => {
    const fake = await jsrFake();

    const plan = await ReleasePublish.plan(request(fake, { commit: OTHER_COMMIT }));

    expect(plan.blockers.map((one) => one.reason)).toContain("commit_not_merged");
  });

  test("refuses to finish from this commit a version another commit half released", async () => {
    await seedGithub({
      compare: { [COMMIT]: "behind" },
      tags: { [`v${version}`]: OTHER_COMMIT },
    });
    const fake = await jsrFake();

    const plan = await ReleasePublish.plan(request(fake));

    expect(plan.blockers.map((one) => one.reason)).toContain("tag_moved");
  });

  test("reports a version an earlier commit released in full as released", async () => {
    // Every push to main after a release carries the released version until the next version
    // pull request merges, so that push has nothing to publish and nothing to refuse.
    await seedGithub({
      compare: { [COMMIT]: "behind" },
      tags: { [`v${version}`]: OTHER_COMMIT },
      releases: {
        [`v${version}`]: `https://github.com/fveracoechea/operator/releases/v${version}`,
      },
    });
    const fake = await jsrFake({ published: [version] });

    const plan = await ReleasePublish.plan(request(fake));
    const result = await ReleasePublish.publish(request(fake));

    expect(plan.state).toBe("released");
    expect(plan.blockers).toEqual([]);
    expect(result.status).toBe("released");
    expect(await fake.calls()).toEqual([]);
  });

  test("refuses to replace a version the registry already holds", async () => {
    const fake = await jsrFake({ published: [version] });

    const plan = await ReleasePublish.plan(request(fake));

    expect(plan.blockers.map((one) => one.reason)).toContain("version_published");
  });
});

describe("the publication", () => {
  test("delivers both paths from one commit", async () => {
    const fake = await jsrFake();

    const result = await ReleasePublish.publish(request(fake));

    expect(result.status).toBe("published");
    const [call, ...more] = await fake.calls();
    expect(more).toEqual([]);
    expect(call?.version).toBe(version);
    // The client publishes a staged copy, so the artifact the identity covers never changes.
    expect(call?.cwd).not.toBe(artifactRoot);
    expect(call?.files).toEqual(await OperatorRelease.contents({ artifactRoot }));
    // It resolves the imports of the shipped code, so the dependencies are installed beside it.
    const manifest = await Bun.file(`${artifactRoot}/package.json`).json();
    expect(call?.installed).toEqual(Object.keys(manifest.dependencies).toSorted());
    const state: ReleaseFakeState = await Bun.file(`${ghDirectory}/state.json`).json();
    expect(state.tags[`v${version}`]).toBe(COMMIT);
    expect(state.releases[`v${version}`]).toContain(`v${version}`);
  });

  test("hands the official client no token of its own", async () => {
    // The client authenticates with the short-lived credential the runner issues to the job.
    const fake = await jsrFake();

    await ReleasePublish.publish(request(fake));

    expect((await fake.calls()).map((call) => call.args)).toEqual([["publish"]]);
  });

  test("keeps the delivered path and retries only the missing one", async () => {
    const fake = await jsrFake({ client: "refuses" });
    const plan = await ReleasePublish.plan(request(fake));

    const first = await ReleasePublish.publish(request(fake));
    expect(first.status).toBe("partial");
    expect(first.status === "partial" && first.journal.paths["github-source"]?.state).toBe(
      "published",
    );

    const retryFake = await jsrFake();
    const retryPlan = await ReleasePublish.plan(request(retryFake));
    expect(retryPlan.releaseId).toBe(plan.releaseId);
    const second = await ReleasePublish.publish(request(retryFake));

    expect(second.status).toBe("published");
    // The source path was already delivered, so the retry sent no second tag request.
    const calls = await Bun.file(`${ghDirectory}/calls.log`).text();
    expect(calls.split("\n").filter((line) => line.includes("git/refs")).length).toBe(1);
    expect((await retryFake.calls()).length).toBe(1);
  });

  test("refuses a retry that would send different content under the same version", async () => {
    const fake = await jsrFake({ client: "refuses" });
    await ReleasePublish.publish(request(fake));

    await Bun.write(`${artifactRoot}/skills/operator/SKILL.md`, "changed\n");
    const retry = await ReleasePublish.publish(request(await jsrFake()));

    expect(retry.status).toBe("blocked");
    expect(retry.status === "blocked" && retry.plan.blockers.map((one) => one.reason)).toContain(
      "artifact_changed",
    );
  });

  test("reads what landed when the client fails after it sent the version", async () => {
    // A failed client does not prove the version is absent, so the registry answers instead.
    const fake = await jsrFake({ client: "publishes-then-fails" });

    const result = await ReleasePublish.publish(request(fake));

    expect(result.status).toBe("published");
    const delivered = await ReleasePublish.delivered({ journalPath });
    expect(delivered.state === "read" && delivered.journal.paths.jsr?.state).toBe("published");
  });

  test("records a refused version as failed, so the next run sends it again", async () => {
    const fake = await jsrFake({ client: "refuses" });

    const result = await ReleasePublish.publish(request(fake));

    expect(result.status).toBe("partial");
    const delivered = await ReleasePublish.delivered({ journalPath });
    expect(delivered.state === "read" && delivered.journal.paths.jsr?.state).toBe("failed");
  });

  test("leaves a faulted tag write uncertain rather than repeating it", async () => {
    await seedFault("create_tag", "server_error");
    const fake = await jsrFake();

    const result = await ReleasePublish.publish(request(fake));

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

const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  jobs: z.record(
    z.string(),
    z.object({
      uses: z.string().optional(),
      needs: z.array(z.string()).optional(),
      if: z.string().optional(),
      outputs: z.record(z.string(), z.string()).optional(),
      permissions: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

async function readWorkflow(path: string) {
  return workflowSchema.parse(Bun.YAML.parse(await Bun.file(`${sourceRoot}/${path}`).text()));
}

describe("the release toolchain", () => {
  test("keeps every third-party action pinned by commit", async () => {
    const workflows = [
      ".github/workflows/quality.yml",
      ".github/workflows/release.yml",
      ".github/workflows/release-smoke.yml",
    ];

    for (const path of workflows) {
      const text = await Bun.file(`${sourceRoot}/${path}`).text();
      const uses = [...text.matchAll(/uses:\s*(\S+)/g)]
        .map((match) => match[1] ?? "")
        // A workflow of this repository runs at the commit that calls it.
        .filter((used) => !used.startsWith("./"));
      expect(uses.length, path).toBeGreaterThan(0);
      for (const used of uses) {
        expect(used, `${path} uses ${used}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  test("publishes only after the quality gate and the release smoke pass on that commit", async () => {
    const release = await readWorkflow(".github/workflows/release.yml");
    const publish = release.jobs.publish;
    const callers = Object.entries(release.jobs).filter(([name]) =>
      (publish?.needs ?? []).includes(name),
    );

    expect(callers.map(([, job]) => job.uses).toSorted()).toEqual([
      "./.github/workflows/quality.yml",
      "./.github/workflows/release-smoke.yml",
      undefined,
    ]);
    // Each called workflow runs on the commit it is called from only because it accepts a call.
    for (const path of [".github/workflows/quality.yml", ".github/workflows/release-smoke.yml"]) {
      expect(Object.keys((await readWorkflow(path)).on), path).toContain("workflow_call");
    }
  });

  test("publishes only when no changeset is still waiting for its version pull request", async () => {
    // Changesets opens the version pull request while changesets are pending. A push with none
    // left is the merge of that pull request, or a push that carries the released version.
    const release = await readWorkflow(".github/workflows/release.yml");

    expect(release.jobs.publish?.needs).toContain("prepare");
    expect(release.jobs.prepare?.outputs?.hasChangesets).toContain("outputs.has-changesets");
    expect(release.jobs.publish?.if).toBe("needs.prepare.outputs.hasChangesets == 'false'");
  });

  test("gives the publish job every scope the reads and writes it makes need", async () => {
    // The job token carries exactly what the job declares. A call it cannot make answers 403.
    const release = await readWorkflow(".github/workflows/release.yml");

    expect(release.jobs.publish?.permissions).toEqual({
      // `repos/.../compare`, the tag refs, and the releases.
      contents: "write",
      // The short-lived credential the official JSR client authenticates with.
      "id-token": "write",
      // `gh run download`, which recovers what an earlier attempt already delivered.
      actions: "read",
    });
  });
});

describe("a source path that is half delivered", () => {
  test("creates the missing release beside the tag a first attempt already landed", async () => {
    await seedFault("create_release", "server_error");
    const fake = await jsrFake();

    const first = await ReleasePublish.publish(request(fake));
    expect(first.status).toBe("partial");
    const afterFirst: ReleaseFakeState = await Bun.file(`${ghDirectory}/state.json`).json();
    expect(afterFirst.tags[`v${version}`]).toBe(COMMIT);
    expect(afterFirst.releases[`v${version}`]).toBeUndefined();

    const retry = await ReleasePublish.publish(request(await jsrFake()));

    expect(retry.status).toBe("published");
    const afterRetry: ReleaseFakeState = await Bun.file(`${ghDirectory}/state.json`).json();
    expect(afterRetry.releases[`v${version}`]).toContain(`v${version}`);
    // The tag the first attempt created is never written a second time.
    const calls = await Bun.file(`${ghDirectory}/calls.log`).text();
    expect(calls.split("\n").filter((line) => line.includes("git/refs")).length).toBe(1);
  });
});

describe("a path the record already names as delivered", () => {
  test("is left alone rather than sent again when the registry answer disagrees", async () => {
    const fake = await jsrFake();
    const first = await ReleasePublish.publish(request(fake));
    expect(first.status).toBe("published");

    // A registry that answers as if it never received the version, and refuses a second send.
    const forgetful = await jsrFake({ client: "refuses" });
    const retry = await ReleasePublish.publish(request(forgetful));

    expect(retry.status).toBe("published");
    expect(await forgetful.calls()).toEqual([]);
    const delivered = await ReleasePublish.delivered({ journalPath });
    expect(delivered.state === "read" && delivered.journal.paths.jsr?.state).toBe("published");
  });
});

describe("the tarball order", () => {
  test("follows the byte order the artifact identity uses, not the locale", async () => {
    await Bun.write(`${artifactRoot}/skills/operator/Z-upper.md`, "upper\n");
    await Bun.write(`${artifactRoot}/skills/operator/a-lower.md`, "lower\n");
    const packed = await ReleasePublish.pack({ artifactRoot });

    const listed = `${artifactRoot}-listing`;
    roots.push(listed);
    await Bun.$`mkdir -p ${listed}`.quiet();
    await Bun.write(`${listed}/artifact.tgz`, packed.bytes);
    const names = (await Bun.$`tar -tzf ${listed}/artifact.tgz`.text())
      .split("\n")
      .filter((name) => name.startsWith("skills/operator/"));

    // `toSorted()` compares code points, so the upper-case name precedes the lower-case one.
    expect(names.indexOf("skills/operator/Z-upper.md")).toBeLessThan(
      names.indexOf("skills/operator/a-lower.md"),
    );
  });
});
