import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { GithubApi } from "../github-api/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { computeReleasePlan, jsrSettings, pathFacts } from "./plan.ts";

afterEach(() => {
  mock.restore();
});

test("release path facts distinguish observed delivery from a missing tag", () => {
  expect(
    pathFacts(
      { state: "due", source: { tag: { status: "absent" } }, commit: "wanted" },
      { path: "github-source", state: "missing", detail: "" },
    ),
  ).toEqual({
    path: "github-source",
    released: false,
    observed: false,
    taggedCommit: null,
    commit: "wanted",
  });
  expect(
    pathFacts(
      { state: "released", source: { tag: { status: "present", sha: "held" } }, commit: "wanted" },
      { path: "jsr", state: "published", detail: "" },
    ),
  ).toEqual({
    path: "jsr",
    released: true,
    observed: true,
    taggedCommit: "held",
    commit: "wanted",
  });
});

test("publication uses the supplied registry or the fixed public registry", () => {
  const input = {
    artifactRoot: "artifact",
    commit: "commit",
    base: "main",
    journalPath: "journal",
  };
  expect(jsrSettings(input)).toMatchObject({
    api: "https://api.jsr.io",
    scope: "fveracoechea",
    package: "operator",
  });
  const jsr = {
    api: "http://127.0.0.1",
    scope: "scope",
    package: "package",
    fetch: globalThis.fetch,
  };
  expect(jsrSettings({ ...input, jsr })).toBe(jsr);
});

test("the release identity covers the repository, version, commit, and artifact content", async () => {
  spyOn(OperatorRelease, "inspect").mockResolvedValue({
    status: "complete",
    artifactRoot: "/artifact",
    artifactIdentity: "content",
    required: [],
    missing: [],
    version: "1.2.3",
    commit: "c".repeat(40),
  });
  spyOn(GithubApi, "call").mockResolvedValue({
    status: "uncertain",
    detail: "no answer",
  });
  const registry = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  let plan;
  try {
    plan = await computeReleasePlan({
      artifactRoot: "/artifact",
      commit: "c".repeat(40),
      base: "main",
      repository: "owner/repo",
      journalPath: "/missing/journal.json",
      changelogPath: "/missing/CHANGELOG.md",
      jsr: {
        api: `http://127.0.0.1:${registry.port}`,
        scope: "owner",
        package: "operator",
        fetch: globalThis.fetch,
      },
    });
  } finally {
    await registry.stop(true);
  }
  expect(plan.releaseId).toBe(
    new Bun.CryptoHasher("sha256")
      .update(
        `{"repository":"owner/repo","version":"1.2.3","commit":"${"c".repeat(40)}","artifactIdentity":"content"}`,
      )
      .digest("hex"),
  );
});
