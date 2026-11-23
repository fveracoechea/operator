import { expect, test } from "bun:test";
import { lintProject } from "../../../tools/oxlint/check.ts";

const check = lintProject();
const policy = JSON.stringify({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
  rules: { "deep-modules/module-imports": "error" },
});

test("the real consumer rejects cross-feature implementation imports", async () => {
  const result = await check('import "../movie/play.ts";', {
    path: "src/modules/tv/main.ts",
    files: {
      ".oxlintrc.json": policy,
      "src/modules/movie/play.ts": "export function play() {}",
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.findings).toEqual(["1 deep-modules(module-imports)"]);
  expect(result.stdout).toContain("docs/module-imports.md");
});

test("nested privacy follows production ownership even without entries", async () => {
  const files = {
    ".oxlintrc.json": policy,
    "src/modules/movie/main.ts": "export const Movie = { play() {} };",
    "src/modules/movie/private.ts": "export const value = 1;",
    "src/modules/movie/schemas.ts": "export type Id = string;",
    "src/modules/movie/player/main.ts": "export function play() {}",
    "src/modules/movie/player/hidden.tsx": "export const hidden = 1;",
    "src/modules/movie/selectors/main.ts": "export function title() {}",
    "src/modules/movie/unfinished/hidden.tsx": "export const hidden = 1;",
  };
  for (const [importer, specifier, rejected] of [
    ["src/modules/movie/private.ts", "./player/main.ts", false],
    ["src/modules/movie/player/consumer.ts", "./hidden.tsx", false],
    ["src/modules/movie/player/consumer.ts", "../selectors/main.ts", false],
    ["src/modules/movie/player/consumer.ts", "../schemas.ts", false],
    ["src/modules/movie/player/consumer.ts", "../main.ts", true],
    ["src/modules/movie/player/consumer.ts", "../private.ts", true],
    ["src/modules/movie/player/consumer.ts", "../selectors/secret.ts", true],
    ["src/modules/movie/private.ts", "./unfinished/hidden.tsx", true],
    ["src/modules/tv/main.ts", "../movie/player/main.ts", true],
    ["probe.config.ts", "./src/modules/movie/player/main.ts", true],
    ["root.test.ts", "./src/modules/movie/main.ts", false],
  ] as const) {
    const result = await check(`import "${specifier}";`, { path: importer, files });
    expect(result.codes).toEqual(rejected ? ["deep-modules(module-imports)"] : []);
    expect(result.exitCode).toBe(rejected ? 1 : 0);
  }
});

test("an alternate consumer cannot bypass privacy with aliases, package identity or omitted extensions", async () => {
  const configured = JSON.stringify({
    categories: { correctness: "off" },
    jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
    rules: { "deep-modules/module-imports": "error", "deep-modules/lib-imports": "error" },
    settings: {
      "deep-modules": {
        projectRoot: "web",
        moduleRoots: ["features"],
        libraryRoots: ["shared"],
        aliases: { "@cinema": "." },
        objectEntries: ["interface.tsx"],
        schemaEntries: ["contract.ts"],
        exclusions: ["features/movie/resources"],
      },
    },
  });
  for (const target of [
    "./web/features/movie/play",
    "./web/features/movie/play.tsx",
    "./web/features/movie/play.jsx",
    "@cinema/features/movie/play",
    "@cinema/features/movie/play.tsx",
    "@screen/cinema/features/movie/play.tsx",
  ]) {
    const result = await check(`import "${target}";`, {
      path: "probe.config.ts",
      files: {
        ".oxlintrc.json": configured,
        "web/package.json": '{"name":"@screen/cinema"}',
        "web/features/movie/play.tsx": "export function play() {}",
        "web/features/movie/interface.tsx": "export const Movie = { play() {} };",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual(["1 deep-modules(module-imports)"]);
  }
});
