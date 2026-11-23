import { expect, test } from "bun:test";
import { lintProject } from "../../../tools/oxlint/check.ts";

const check = lintProject();
const policy = JSON.stringify({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
  rules: { "deep-modules/synchronous-selectors": "error" },
});

test("direct namespace selector entries report async behavior at a current-source location", async () => {
  for (const declaration of [
    'export * as Cast from "./cast/main.ts";',
    'export * from "./cast/main.ts";',
    'export { byTitle } from "./cast/main.ts";',
  ]) {
    const result = await check(declaration, {
      path: "src/modules/movie/selectors/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/selectors/cast/main.ts":
          "export async function byTitle() { return true; }",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual(["1 deep-modules(synchronous-selectors)"]);
    expect(result.stdout).toContain("Selector implementations must be synchronous");
    expect(result.stdout).toContain("docs/synchronous-selectors.md");
    expect(result.stdout).not.toContain("Invalid deep-modules configuration");
    expect(result.stdout).not.toContain("node.range");
  }
});

test("namespace cycles cannot report parsed copies of the current source as SDK nodes", async () => {
  const result = await check(
    'export * as Self from "./main.ts";\nexport async function byTitle() { return true; }',
    {
      path: "src/modules/movie/selectors/main.ts",
      files: { ".oxlintrc.json": policy },
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.findings.toSorted()).toEqual([
    "1 deep-modules(synchronous-selectors)",
    "3 deep-modules(synchronous-selectors)",
  ]);
  expect(result.stdout).not.toContain("Invalid deep-modules configuration");
  expect(result.stdout).not.toContain("node.range");
});

test("namespace selector exports expose async implementations in nested owners", async () => {
  const result = await check(
    'import * as selectors from "./selectors/main.ts"; export const Movie = { selectors, async play() {} };',
    {
      path: "src/modules/movie/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/selectors/main.ts": 'export * as Cast from "./cast/main.ts";',
        "src/modules/movie/selectors/cast/main.ts":
          "export async function byTitle() { return true; }",
      },
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.findings).toEqual(["3 deep-modules(synchronous-selectors)"]);
  expect(result.stdout).not.toContain("Invalid deep-modules configuration");
  expect(result.stdout).not.toContain("node.range");
});

test("explicit object-member Promise contracts reject synchronous-looking selector bodies", async () => {
  for (const source of [
    'export const Selectors: { title: () => Promise<string> } = { title: () => Promise.resolve("x") };',
    "export const Selectors: { title(): globalThis.Promise<string> } = { title: () => hidden() };",
    "export const Selectors = { title: () => hidden() } satisfies { title: () => Promise<string> };",
    "export const Selectors: { nested: { title: () => Promise<string> } } = { nested: { title: () => hidden() } };",
    "export const Selectors: { byTitle: () => (movie: string) => Promise<boolean> } = { byTitle: () => hidden() };",
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/selectors/main.ts",
      files: { ".oxlintrc.json": policy },
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual(["1 deep-modules(synchronous-selectors)"]);
  }
});

test("namespace members and named namespace imports trace only exposed selector implementations", async () => {
  for (const exposure of [
    'import { Cast } from "./domain/main.ts"; export const Movie = { selectors: Cast };',
    'import * as Domain from "./domain/main.ts"; export const Movie = { selectors: Domain.Cast };',
  ]) {
    const result = await check(exposure, {
      path: "src/modules/movie/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/domain/main.ts": 'export * as Cast from "./cast/main.ts";',
        "src/modules/movie/domain/cast/main.ts":
          "export const Cast: { title(): Promise<string> } = { title: () => hidden() };",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual(["3 deep-modules(synchronous-selectors)"]);
  }
});

test("object contracts do not infer Promise returns from parameters, aliases or unrelated operations", async () => {
  for (const source of [
    'export const Selectors: { title(input: Promise<string>): string } = { title: () => "x" };',
    "type Contract = { title: () => Promise<string> }; export const Selectors: Contract = hidden;",
    "export const Selectors: { title: () => string } = { title: () => hidden() };",
    "export const Selectors = { title: () => hidden() };",
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/selectors/main.ts",
      files: { ".oxlintrc.json": policy },
    });
    expect(result.exitCode).toBe(0);
    expect(result.codes).toEqual([]);
  }
});

test("selector sub-modules reject async declarations with a precise shipped-guidance diagnostic", async () => {
  const result = await check("export async function byTitle() { return true; }", {
    path: "src/modules/movie/selectors/main.ts",
    files: { ".oxlintrc.json": policy },
  });
  expect(result.exitCode).toBe(1);
  expect(result.findings).toEqual(["1 deep-modules(synchronous-selectors)"]);
  expect(result.stdout).toContain("docs/synchronous-selectors.md");
  expect(result.stdout).toContain("synchronous");
});

test("selector implementations include expressions, Promise contracts and returned async predicates", async () => {
  for (const source of [
    "export const title = async () => true;",
    "export const title = async function () { return true; };",
    "export function title(): Promise<string> { return hidden(); }",
    "export const title = (): globalThis.Promise<string> => hidden();",
    "export const title = () => async (movie: string) => movie;",
    "const predicate = async () => true; export function byTitle() { return predicate; }",
    "export function byTitle(flag: boolean) { return flag ? async () => true : () => false; }",
    "export const Selectors = { async title() { await hidden(); } };",
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/selectors/main.ts",
      files: { ".oxlintrc.json": policy },
    });
    expect(result.exitCode).toBe(1);
    expect(result.codes).toContain("deep-modules(synchronous-selectors)");
  }
});

test("Movie exposes traced selector groups without making its async operations selectors", async () => {
  const result = await check(
    [
      "const byTitle = async () => true;",
      "const domain = ({ byTitle } as const);",
      "const alias = domain!;",
      "export const Movie = { selectors: (alias satisfies object), async play() {} };",
    ].join("\n"),
    { path: "src/modules/movie/main.ts", files: { ".oxlintrc.json": policy } },
  );
  expect(result.exitCode).toBe(1);
  expect(result.findings).toEqual(["1 deep-modules(synchronous-selectors)"]);
});

test("namespace imports and immutable aliases trace exposed domain selectors across project files", async () => {
  const result = await check(
    [
      'import * as domain from "./domain/main.ts";',
      "const alias = domain;",
      "export const Movie = { selectors: alias, async play() {} };",
    ].join("\n"),
    {
      path: "src/modules/movie/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/domain/main.ts": "export async function byTitle() { return true; }",
      },
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.codes).toContain("deep-modules(synchronous-selectors)");
  expect(result.stdout).not.toContain("Invalid deep-modules configuration");
  expect(result.findings).toEqual(["4 deep-modules(synchronous-selectors)"]);
});

test("configured selector sub-modules use the same settings and ownership exclusions", async () => {
  const configured = JSON.stringify({
    categories: { correctness: "off" },
    jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
    rules: { "deep-modules/synchronous-selectors": "error" },
    settings: {
      "deep-modules": {
        moduleRoots: ["features"],
        selectorSubmodules: ["projections"],
        exclusions: ["features/movie/projections/generated"],
      },
    },
  });
  for (const [filename, rejected] of [
    ["features/movie/projections/main.ts", true],
    ["features/movie/projections/generated/main.ts", false],
    ["features/movie/selectors/main.ts", false],
    ["features/movie/projections/main.test.ts", false],
  ] as const) {
    const result = await check("export async function title() { return true; }", {
      path: filename,
      files: { ".oxlintrc.json": configured },
    });
    expect(result.exitCode).toBe(rejected ? 1 : 0);
    expect(result.codes).toEqual(rejected ? ["deep-modules(synchronous-selectors)"] : []);
  }
});

test("synchronous domain predicates, projections and opaque dependencies remain valid", async () => {
  const result = await check(
    `
import { opaque } from "external-package";
function title(movie: { title: string }) { return movie.title; }
function byTitle(text: string) { return (movie: { title: string }) => title(movie) === text; }
const projection = (movie: { title: string }) => title(movie);
const Selectors = { title, byTitle, projection, opaque };
export { Selectors };
`,
    {
      path: "src/modules/movie/selectors/main.ts",
      files: { ".oxlintrc.json": policy },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.codes).toEqual([]);
});

test("unrelated async operations and unexposed helpers are outside the selector contract", async () => {
  const result = await check(
    `
async function load() { await remote(); }
function title(movie: string) { const unused = async () => remote(); return movie; }
export const Movie = { selectors: { title }, load };
`,
    {
      path: "src/modules/movie/main.ts",
      files: { ".oxlintrc.json": policy },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.codes).toEqual([]);
});

test("the documented Movie.selector interface traces named imports, namespace members and export aliases", async () => {
  for (const source of [
    'import { Rules as domain } from "./rules/main"; export const Movie = { selector: domain };',
    'import * as domain from "./rules/main"; export const Movie = { selector: domain.Rules };',
    'import { Rules } from "./rules/main"; const domain = (Rules as const); const Movie = { selector: domain }; export { Movie };',
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/main.ts",
      files: {
        ".oxlintrc.json": policy,
        "src/modules/movie/rules/main.ts":
          "const title = async () => true; export const Rules = { title };",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.codes).toContain("deep-modules(synchronous-selectors)");
    expect(result.stdout).not.toContain("Invalid deep-modules configuration");
  }
});

test("explicit awaited selector values and annotated Promise function contracts fail", async () => {
  for (const source of [
    "export const title = await hidden();",
    "export const title: () => Promise<string> = () => hidden();",
    'import { hidden } from "opaque-package"; export const title: () => Promise<string> = hidden;',
    "export const title = (() => hidden()) satisfies (() => Promise<string>);",
    "export function byTitle(): (movie: string) => Promise<boolean> { return hidden(); }",
    "export const title = (): string | Promise<string> => hidden();",
  ]) {
    const result = await check(source, {
      path: "src/modules/movie/selectors/main.ts",
      files: { ".oxlintrc.json": policy },
    });
    expect(result.exitCode).toBe(1);
    expect(result.codes).toContain("deep-modules(synchronous-selectors)");
  }
});

test("library-root precedence prevents an inherited module owner from creating selector contracts", async () => {
  const configured = JSON.stringify({
    categories: { correctness: "off" },
    jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
    rules: { "deep-modules/synchronous-selectors": "error" },
    settings: {
      "deep-modules": { libraryRoots: ["features/movie/shared"], moduleRoots: ["features"] },
    },
  });
  const result = await check("export const helpers = { selector: { title: async () => true } };", {
    path: "features/movie/shared/main.ts",
    files: {
      ".oxlintrc.json": configured,
      "features/movie/main.ts": "export const Movie = { play() {} };",
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.codes).toEqual([]);
});

test("alternate roots, aliases and package-self imports share TSX selector resolution", async () => {
  const configured = JSON.stringify({
    categories: { correctness: "off" },
    jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
    rules: { "deep-modules/synchronous-selectors": "error" },
    settings: { "deep-modules": { moduleRoots: ["features"], aliases: { "@app": "." } } },
  });
  for (const specifier of [
    "./domain/main",
    "./domain/main.jsx",
    "@app/features/movie/domain/main",
    "@screen/cinema/features/movie/domain/main.tsx",
  ]) {
    const result = await check(
      `import { Rules as rules } from "${specifier}";
export const Movie = { selector: rules };`,
      {
        path: "features/movie/main.ts",
        files: {
          ".oxlintrc.json": configured,
          "package.json": '{"name":"@screen/cinema","type":"module"}',
          "features/movie/domain/main.tsx":
            "export const Rules = { title: (): Promise<string> => hidden() };",
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.codes).toEqual(["deep-modules(synchronous-selectors)"]);
    expect(result.findings).toEqual(["3 deep-modules(synchronous-selectors)"]);
  }
});
