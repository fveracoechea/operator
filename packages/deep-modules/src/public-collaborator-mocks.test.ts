import { expect, test } from "bun:test";
import { lintProject } from "../../../tools/oxlint/check.ts";

const check = lintProject();
const policy = JSON.stringify({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
  rules: { "deep-modules/public-collaborator-mocks": "error" },
});

test("Operator replaces only the governed test ban and retains unrelated test policy", async () => {
  const accepted = await check(
    'import { mock } from "bun:test"; await mock.module("external-client", () => ({}));',
    { path: "collaborator-probe.test.ts" },
  );
  expect(accepted.codes).toEqual([]);
  expect(accepted.exitCode).toBe(0);
  const production = await check(
    'import { mock } from "bun:test"; mock.module("external-client", () => ({}));',
  );
  expect(production.codes).toContain("anti-slop(no-module-mocking)");
  const unrelated = await check(
    'import { expect } from "bun:test"; const draft = { id: "a" }; expect(draft.id).toBe("a");',
    { path: "collaborator-probe.test.ts" },
  );
  expect(unrelated.codes).toContain("custom-tests(no-fixture-assertion)");
});

test("real Bun bindings, static members and immutable aliases preserve privacy without name false positives", async () => {
  for (const source of [
    'import { mock as fake } from "bun:test"; fake["module"]("./main.ts", () => ({}));',
    'import * as Test from "bun:test"; Test.mock.module("./main.ts", () => ({}));',
    'import * as Test from "bun:test"; const fake = Test["mock"]; const replace = fake.module; replace("./main.ts", () => ({}));',
    'import { mock } from "bun:test"; const { module: replace } = mock; replace("./main.ts", () => ({}));',
    'import * as Test from "bun:test"; const { mock: fake } = Test; fake.module("./main.ts", () => ({}));',
    'import { jest as fake } from "bun:test"; fake.mock("./main.ts", () => ({}));',
    'import { vi } from "bun:test"; vi.doMock("./main.ts", () => ({}));',
    'import { mock } from "bun:test"; const fake = (mock as typeof mock); fake.module("./main.ts", () => ({}));',
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/main.test.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/main.ts": "export const Movie = {};",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(["deep-modules(public-collaborator-mocks)"]);
  }
  for (const source of [
    'const mock = { module() {} }; mock.module("./main.ts");',
    'import { mock } from "bun:test"; function run(mock) { mock.module("./main.ts"); }',
    'import * as Test from "bun:test"; function run(Test) { Test.mock.module("./main.ts"); }',
    'import { mock, spyOn } from "bun:test"; const fn = mock(() => 1); spyOn({ run() {} }, "run");',
  ]) {
    const result = await check(source, {
      path: "root.test.ts",
      files: { ".oxlintrc.json": policy },
    });
    expect(result.exitCode).toBe(0);
    expect(result.codes).toEqual([]);
  }
});

test("parent tests keep descendants real and sibling tests use declared entries", async () => {
  for (const [importer, target, rejected] of [
    ["src/modules/movie/main.test.ts", "./player/main", true],
    ["src/modules/movie/main.test.ts", "./player/hidden.tsx", true],
    ["src/modules/movie/player/main.test.ts", "../selectors/main", false],
    ["src/modules/movie/player/main.test.ts", "../selectors/secret", true],
    ["src/modules/movie/player/main.test.ts", "../main", true],
    ["root.test.ts", "./src/modules/movie/player/main", true],
  ] as const) {
    const result = await check(
      `import { mock } from "bun:test"; mock.module("${target}", () => ({}));`,
      {
        path: importer,
        files: {
          ".oxlintrc.json": policy,
          "src/modules/movie/main.ts": "export const Movie = {};",
          "src/modules/movie/player/main.ts": "export function play() {}",
          "src/modules/movie/player/hidden.tsx": "export const hidden = 1;",
          "src/modules/movie/selectors/main.ts": "export function title() {}",
          "src/modules/movie/selectors/secret.ts": "export const secret = 1;",
        },
      },
    );
    expect(result.exitCode).toBe(rejected ? 1 : 0);
    expect(result.codes).toEqual(rejected ? ["deep-modules(public-collaborator-mocks)"] : []);
  }
});

test("shared setup needs an explicit owner, opaque targets fail and configured environment entries are public", async () => {
  const configured = JSON.stringify({
    ...JSON.parse(policy),
    settings: {
      "deep-modules": {
        testScopes: { "test/setup.ts": "src/modules/movie" },
        environmentEntries: ["src/environment.ts"],
        aliases: { "@": "src" },
        exclusions: ["src/modules/tv/resources"],
      },
    },
  });
  for (const [filename, source, rejection] of [
    ["setup.ts", 'mock.module("external", () => ({}));', "explicit testScopes"],
    ["test/setup.ts", 'mock.module("@/modules/movie/main", () => ({}));', "Keep the tested owner"],
    [
      "test/setup.ts",
      'mock.module("../src/modules/movie/player/main", () => ({}));',
      "Keep the tested owner",
    ],
    ["test/setup.ts", 'mock.module("@/modules/tv/main", () => ({}));', null],
    ["test/setup.ts", 'mock.module("@/environment", () => ({}));', null],
    ["root.test.ts", "mock.module(getTarget(), () => ({}));", "Unsupported mock target"],
    ["root.test.ts", "mock.module();", "Unsupported mock target"],
    ["root.test.ts", 'const target = "@/modules/tv/main"; mock.module(target, () => ({}));', null],
    ["root.test.ts", 'mock.module("@/private.ts", () => ({}));', "Mock only"],
    ["root.test.ts", 'mock.module("@/modules/tv/resources/main", () => ({}));', "Mock only"],
  ] as const) {
    const result = await check(`import { mock } from "bun:test"; ${source}`, {
      path: filename,
      files: {
        ".oxlintrc.json": configured,
        "src/modules/movie/main.ts": "export const Movie = {};",
        "src/modules/movie/player/main.ts": "export function play() {}",
        "src/modules/tv/main.ts": "export const Tv = {};",
        "src/environment.ts": "export const mode = 'test';",
        "src/private.ts": "export const hidden = 1;",
        "src/modules/tv/resources/main.ts": "export const resource = 1;",
      },
    });
    expect(result.exitCode).toBe(rejection ? 1 : 0);
    expect(result.codes).toEqual(rejection ? ["deep-modules(public-collaborator-mocks)"] : []);
    if (rejection) expect(result.stdout).toContain(rejection);
  }
});

test("consumer permits public collaborators but rejects replacing the tested owner", async () => {
  for (const [target, rejected] of [
    ["../tv/main.ts", false],
    ["external-client", false],
    ["./main.ts", true],
    ["../tv/private.ts", true],
  ] as const) {
    const result = await check(
      `import { mock } from "bun:test"; mock.module("${target}", () => ({}));`,
      {
        path: "src/modules/movie/main.test.ts",
        files: {
          ".oxlintrc.json": policy,
          "src/modules/movie/main.ts": "export const Movie = {};",
          "src/modules/tv/main.ts": "export const Tv = {};",
          "src/modules/tv/private.ts": "export const secret = 1;",
        },
      },
    );
    expect(result.exitCode).toBe(rejected ? 1 : 0);
    expect(result.codes).toEqual(rejected ? ["deep-modules(public-collaborator-mocks)"] : []);
    if (rejected) expect(result.stdout).toContain("docs/public-collaborator-mocks.md");
  }
});
