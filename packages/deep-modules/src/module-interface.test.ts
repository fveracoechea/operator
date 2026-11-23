import { expect, test } from "bun:test";
import { lintProject } from "../../../tools/oxlint/check.ts";

const check = lintProject();
const rulePolicy = {
  plugins: ["oxc"],
  categories: { correctness: "off" },
  jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
  rules: { "deep-modules/module-interface": "error", "oxc/no-barrel-file": "error" },
};
const policy = JSON.stringify(rulePolicy);

test("Movie composes references, namespace selectors, data constants and types without a barrel exception", async () => {
  const result = await check(
    `
import { play } from "./play.ts";
import * as selectors from "./selectors/main.ts";
export type MovieId = string;
export interface Options { autoplay: boolean }
export const MOVIE_TIMEOUT = 500;
export const Defaults = { autoplay: false };
export const GENRES = ["drama", "comedy"];
export const Movie = ({ play, selectors, UI: { Screen: play } } as const) satisfies object;
`,
    {
      path: "src/modules/movie/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/play.ts": "export function play() { return 1; }",
        "src/modules/movie/selectors/main.ts": "export function title() { return 'Alien'; }",
      },
    },
  );
  expect(result.codes).toEqual([]);
  expect(result.exitCode).toBe(0);
});

test("application operations belong on the named object through the consumer command", async () => {
  const result = await check("export function play() {}", {
    path: "src/modules/movie/main.ts",
    files: { ".oxlintrc.json": policy },
  });
  expect(result.exitCode).toBe(1);
  expect(result.codes).toContain("deep-modules(module-interface)");
  expect(result.stdout).toContain("docs/module-interface.md");
  expect(result.findings).toContain("1 deep-modules(module-interface)");
});

test("rejects callable aliases and syntax wrappers but does not invent imported types", async () => {
  for (const source of [
    "export const play = () => 1;",
    "export const play = function () {};",
    "function play() {} const alias = play; export { alias };",
    "const play = (() => 1) satisfies () => number; export const alias = (play!);",
    "export default { play() {} };",
    "export const timeout = 500;",
    "export const movie = { play() {} };",
    "export const Movie = { play() {} }; export const Other = { stop() {} };",
    "export const Movie = { play() {} }; export const other = { stop() {} };",
    "export const Movie = {};",
    "export declare function play(): void; export const Movie = { value: true };",
    "const value = 1; export { value as default }; export const Movie = { value: true };",
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/main.ts",
      files: { ".oxlintrc.json": policy },
    });
    expect(result.exitCode).toBe(1);
    expect(result.codes).toContain("deep-modules(module-interface)");
  }
});

test("uses consumer configuration and leaves internal, library, schema, framework and excluded entries alone", async () => {
  const configured = JSON.stringify({
    ...rulePolicy,
    settings: {
      "deep-modules": {
        projectRoot: "web",
        moduleRoots: ["features"],
        libraryRoots: ["utils"],
        objectEntries: ["interface.ts"],
        exclusions: ["features/generated"],
      },
    },
  });
  const bad = await check("export const play = () => 1;", {
    path: "web/features/movie/interface.ts",
    files: { ".oxlintrc.json": configured },
  });
  expect(bad.codes).toContain("deep-modules(module-interface)");
  for (const entry of [
    "web/features/movie/internal/interface.ts",
    "web/features/generated/interface.ts",
    "web/utils/interface.ts",
    "src/modules/movie/main.ts",
    "web/features/movie/schemas.ts",
    "web/features/movie/$functions.ts",
  ]) {
    const good = await check("export function play() {}", {
      path: entry,
      files: { ".oxlintrc.json": configured },
    });
    expect(good.codes).toEqual([]);
  }
});

test("accepts opaque constants, data arrays, local object aliases and guarded binding cycles", async () => {
  for (const source of [
    'import { opaque } from "./opaque.ts"; export const UNKNOWN = opaque; export const Movie = { opaque };',
    'import { factory } from "./opaque.ts"; export const COMPUTED = factory(); export const Movie = { value: COMPUTED };',
    "const a = b; const b = a; export const CYCLE = a; export const Movie = { value: a };",
    "const impl = { play() {} }; export const Movie = impl;",
    "export const Movie = { value: true }; export const VALUES = [1, { code: 'a' }];",
    "const recursive = { recursive }; export const Movie = recursive;",
    "function play() {} export const Movie = { play }; export type Play = typeof play;",
    "const play = function () {}; const alias = play; export const Movie = { alias };",
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/opaque.ts":
          "export const opaque = 1; export function factory() { return 1; }",
      },
    });
    expect(result.codes).toEqual([]);
  }
});

test("validates configuration even when the file is not an application entry", async () => {
  const result = await check("export const value = 1;", {
    files: {
      ".oxlintrc.json": JSON.stringify({
        ...rulePolicy,
        settings: { "deep-modules": { moduleRoot: "typo" } },
      }),
    },
  });
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("moduleRoot");
});

test("curated named exports and namespace groups remain compatible with pinned no-barrel", async () => {
  const result = await check(
    'export { title } from "./title.ts"; export * as predicates from "./predicates.ts";',
    {
      path: "src/modules/movie/selectors/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/selectors/title.ts": "export function title() { return 'Alien'; }",
        "src/modules/movie/selectors/predicates.ts": "export function watched() { return true; }",
      },
    },
  );
  expect(result.codes).toEqual([]);
  expect(result.exitCode).toBe(0);
});
