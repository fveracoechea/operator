import { expect, test } from "bun:test";
import { lintProject } from "../../../tools/oxlint/check.ts";

const check = lintProject();
const policy = JSON.stringify({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
  rules: {
    "deep-modules/query-options-owner": "error",
    "deep-modules/module-imports": "error",
  },
});

test("parent-local construction fails even when the other group's provenance is opaque", async () => {
  for (const source of [
    "export const Movie = { queryOptions: { findOne() {} }, mutationOptions: { publish() {} } };",
    `import { queryOptions } from "./query-options/main.ts";
const mutationOptions = { publish() {} };
export const Movie = { queryOptions, mutationOptions };`,
    "const queryOptions = {}; const mutationOptions = buildOptions(); export const Movie = { queryOptions, mutationOptions };",
  ]) {
    const result = await check(source, { path: "src/modules/movie/main.ts", files });
    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(["deep-modules(query-options-owner)"]);
  }
});

test("known parent files and public sibling capabilities are not internal query owners", async () => {
  for (const specifier of ["./local-options.ts", "../catalog/main.ts"]) {
    const result = await check(
      `import { queryOptions, mutationOptions } from "${specifier}";
export const Movie = { queryOptions, mutationOptions };`,
      {
        path: "src/modules/movie/main.ts",
        files: {
          ...files,
          "src/modules/movie/local-options.ts":
            "export const queryOptions = {}; export const mutationOptions = {};",
          "src/modules/catalog/main.ts":
            "export const queryOptions = {}; export const mutationOptions = {};",
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(["deep-modules(query-options-owner)"]);
  }
});

test("single groups, opaque computed values and alias cycles do not speculate about ownership", async () => {
  for (const source of [
    "export const Movie = { queryOptions: {} };",
    "export const Movie = { mutationOptions: {} };",
    "export const Movie = { queryOptions: buildReads(), mutationOptions: buildWrites() };",
    "const a = b; const b = a; export const Movie = { queryOptions: a, mutationOptions: b };",
    "const a = b.queryOptions; const b = a; export const Movie = { queryOptions: a, mutationOptions: b };",
    "export const Movie = { queryOptions: {}, mutationOptions: {}, ...opaque };",
    `import * as options from "./query-options/main.ts";
export const Movie = { queryOptions: options[key], mutationOptions: buildWrites() };`,
  ]) {
    const result = await check(source, { path: "src/modules/movie/main.ts", files });
    expect(result.exitCode).toBe(0);
    expect(result.codes).toEqual([]);
  }
});
const files = {
  ".oxlintrc.json": policy,
  "src/modules/movie/query-options/main.ts":
    "export const queryOptions = { findOne() {} }; export const mutationOptions = { publish() {} };",
  "src/modules/movie/commands/main.ts": "export const mutationOptions = { publish() {} };",
};

test("separately exposed query and mutation groups reject known split owners", async () => {
  const result = await check(
    `import { queryOptions } from "./query-options/main.ts";
import { mutationOptions } from "./commands/main.ts";
export const Movie = { queryOptions, mutationOptions };`,
    { path: "src/modules/movie/main.ts", files },
  );
  expect(result.exitCode).toBe(1);
  expect(result.codes).toEqual(["deep-modules(query-options-owner)"]);
  expect(result.findings).toEqual(["5 deep-modules(query-options-owner)"]);
  expect(result.stdout).toContain("same owning internal sub-module");
  expect(result.stdout).toContain("docs/query-options-owner.md");
});

test("syntax wrappers and immutable aliases preserve imported ownership", async () => {
  for (const [source, rejected] of [
    [
      `import { queryOptions, mutationOptions } from "./query-options/main.ts";
const groups = { queryOptions, mutationOptions };
export const Movie = { queryOptions: groups.queryOptions, mutationOptions: groups.mutationOptions };`,
      false,
    ],
    [
      `import * as options from "./query-options/main.ts";
const groups = { queryOptions: {}, ...opaque, queryOptions: options.queryOptions, mutationOptions: options.mutationOptions };
export const Movie = { queryOptions: groups.queryOptions, mutationOptions: groups.mutationOptions };`,
      false,
    ],
    [
      `import * as options from "./query-options/main.ts";
import * as commands from "./commands/main.ts";
export const Movie = { queryOptions: options["queryOptions"], mutationOptions: commands["mutationOptions"] };`,
      true,
    ],
    [
      `import { queryOptions, mutationOptions } from "./query-options/main.ts";
export const Movie = { queryOptions, mutationOptions };`,
      false,
    ],
    [
      `import { queryOptions as reads, mutationOptions as writes } from "./query-options/main.ts";
const q = (reads as object)!; const m = writes satisfies object;
const publicInterface = ({ queryOptions: q, mutationOptions: m } as const);
export { publicInterface as Movie };`,
      false,
    ],
    [
      `import * as options from "./query-options/main.ts";
const alias = options;
export const Movie = { queryOptions: alias.queryOptions, mutationOptions: options.mutationOptions };`,
      false,
    ],
    [
      `import * as options from "./query-options/main.ts";
import * as commands from "./commands/main.ts";
const q = (options.queryOptions as object)!;
const m = (commands.mutationOptions satisfies object);
export const Movie = { queryOptions: q, mutationOptions: m };`,
      true,
    ],
  ] as const) {
    const result = await check(source, { path: "src/modules/movie/main.ts", files });
    expect(result.codes).toEqual(rejected ? ["deep-modules(query-options-owner)"] : []);
    expect(result.exitCode).toBe(rejected ? 1 : 0);
  }
});

test("Movie composes selected capabilities through legal child entries", async () => {
  const result = await check(
    `import { Media } from "./media/main.ts";
import * as selectors from "./selectors/main.ts";
import { queryOptions, mutationOptions } from "./query-options/main.ts";
import * as UI from "./ui/main.ts";
export const MOVIE_TIMEOUT = 500;
export const Movie = {
  async play(id: string) { const video = await Media.find(id); return Media.play(video); },
  selector: selectors, queryOptions, mutationOptions, UI,
};`,
    {
      path: "src/modules/movie/main.ts",
      files: {
        ...files,
        ".oxlintrc.json": JSON.stringify({
          categories: { correctness: "off" },
          jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
          rules: {
            "deep-modules/module-interface": "error",
            "deep-modules/module-imports": "error",
            "deep-modules/query-options-owner": "error",
          },
        }),
        "src/modules/movie/media/main.ts":
          "export const Media = { async find(id: string) { return id; }, play(video: string) { return video; } };",
        "src/modules/movie/selectors/main.ts": "export function isReleased() { return true; }",
        "src/modules/movie/ui/main.ts": "export function Carousel() {}",
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.codes).toEqual([]);
});

test("consumer roots, entries, alias and package identity use shared resolution", async () => {
  const configured = JSON.stringify({
    categories: { correctness: "off" },
    jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
    rules: { "deep-modules/query-options-owner": "error", "deep-modules/module-imports": "error" },
    settings: {
      "deep-modules": {
        projectRoot: "web",
        moduleRoots: ["features"],
        libraryRoots: ["features/shared"],
        aliases: { "@app": "." },
        objectEntries: ["interface.tsx"],
        exclusions: ["features/ignored"],
      },
    },
  });
  for (const [specifier, rejected] of [
    ["@app/features/movie/options/interface", false],
    ["@cinema/app/features/movie/options/interface.tsx", false],
    ["@app/features/movie/commands/interface", true],
  ] as const) {
    const result = await check(
      `import { queryOptions } from "@app/features/movie/options/interface";
import { mutationOptions } from "${specifier}";
export const Movie = { queryOptions, mutationOptions };`,
      {
        path: "web/features/movie/interface.tsx",
        files: {
          ".oxlintrc.json": configured,
          "web/package.json": '{"name":"@cinema/app"}',
          "web/features/movie/options/interface.tsx":
            "export const queryOptions = {}; export const mutationOptions = {};",
          "web/features/movie/commands/interface.tsx": "export const mutationOptions = {};",
        },
      },
    );
    expect(result.codes).toEqual(rejected ? ["deep-modules(query-options-owner)"] : []);
    expect(result.exitCode).toBe(rejected ? 1 : 0);
  }
  for (const entry of [
    "web/features/ignored/interface.tsx",
    "web/features/shared/interface.tsx",
    "web/features/movie/options/interface.tsx",
    "web/features/movie/interface.test.ts",
    "src/lib/probe.ts",
  ]) {
    const result = await check("export const Movie = { queryOptions: {}, mutationOptions: {} };", {
      path: entry,
      files: { ".oxlintrc.json": configured },
    });
    expect(result.exitCode).toBe(0);
  }
});

test("invalid shared configuration fails visibly through this rule", async () => {
  const result = await check("export const Movie = {};", {
    path: "src/modules/movie/main.ts",
    files: {
      ".oxlintrc.json": JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
        rules: { "deep-modules/query-options-owner": "error" },
        settings: { "deep-modules": { moduleRoots: "invalid" } },
      }),
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.codes).toEqual(["deep-modules(query-options-owner)"]);
  expect(result.stdout).toContain("Invalid deep-modules configuration");
});
