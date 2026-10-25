import { expect, test } from "bun:test";
import { jsrSettings, pathFacts } from "./plan.ts";

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
