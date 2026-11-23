import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory, directory-creation receipt, metadata, or recursive removal API.
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { lintProject } from "../../../tools/oxlint/check.ts";
import recommended from "../recommended.json";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function command(cwd: string, args: string[]) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const report = z.object({
  diagnostics: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      filename: z.string(),
      labels: z.array(z.object({ span: z.object({ line: z.number() }) })),
    }),
  ),
});

// Each probe restores overwritten files as well as removing additions, including configuration.
async function withFiles(
  consumer: string,
  files: Record<string, string | null>,
  probe: () => Promise<void>,
) {
  const originals = new Map<string, string | null>();
  const createdDirectories = new Set<string>();
  for (const name of Object.keys(files)) {
    const file = Bun.file(path.join(consumer, name));
    originals.set(name, (await file.exists()) ? await file.text() : null);
  }
  try {
    for (const [name, source] of Object.entries(files)) {
      if (source === null) {
        await rm(path.join(consumer, name), { force: true });
        continue;
      }
      const created = await mkdir(path.dirname(path.join(consumer, name)), { recursive: true });
      if (created) createdDirectories.add(created);
      await Bun.write(path.join(consumer, name), source);
    }
    await probe();
  } finally {
    for (const [name, original] of originals) {
      await (original === null
        ? rm(path.join(consumer, name), { force: true })
        : Bun.write(path.join(consumer, name), original));
    }
    for (const directory of createdDirectories)
      await rm(directory, { recursive: true, force: true });
  }
}

function movieProject(moduleRoot: string, basename: string): Record<string, string> {
  const movie = `${moduleRoot}/movie`;
  const files: Record<string, string> = {
    [`${movie}/${basename}`]: `
import { Media } from "./media/${basename}";
import * as selectors from "./selectors/${basename}";
import { queryOptions, mutationOptions } from "./query-options/${basename}";
import * as UI from "./ui/${basename}";
export type MovieId = string;
export interface Options { autoplay: boolean }
export const MOVIE_TIMEOUT = 500;
export const Defaults = { autoplay: false };
export const GENRES = ["drama", "comedy"];
export const Movie = {
  async play(id: MovieId) { const video = await Media.find(id); return Media.play(video); },
  selector: selectors, queryOptions, mutationOptions, UI,
};`,
    [`${movie}/media/${basename}`]:
      "export const Media = { async find(id: string) { return id; }, play(video: string) { return video; } };",
    [`${movie}/media/private.ts`]: "export const TIMEOUT = 500;",
    [`${movie}/selectors/${basename}`]:
      'export { isReleased, budgetIsBiggerThan, toCast } from "./predicates.ts"; export * as Cast from "./cast.ts";',
    [`${movie}/selectors/predicates.ts`]: `
export function isReleased(movie: {status: string}) { return movie.status === "released"; }
export function budgetIsBiggerThan(minimum: number) {
  return (movie: {budget: number}) => movie.budget > minimum;
}
export function toCast(predicate: (person: {age: number}) => boolean) {
  return (movie: {cast: {age: number}[]}) => movie.cast.filter(predicate);
}`,
    [`${movie}/selectors/cast.ts`]:
      "export function isAdult(person: {age: number}) { return person.age >= 18; }",
    [`${movie}/query-options/${basename}`]:
      "export const queryOptions = { findOne() {} }; export const mutationOptions = { publish() {} };",
    [`${movie}/commands/${basename}`]: "export const mutationOptions = { publish() {} };",
    [`${movie}/ui/${basename}`]: "export function Carousel() {}",
    [`${movie}/private.tsx`]: "export type Id = string;",
    [`${moduleRoot}/tv-shows/${basename}`]: "export const TvShows = { play() {} };",
    "consumer.test.ts": `import { Movie } from "./${movie}/${basename}"; console.log(Movie);`,
    "consumer.config.ts": `export type Movie = typeof import("./${movie}/${basename}").Movie;`,
  };
  for (const name of Object.keys(files)) {
    if (name.endsWith(`/${basename}`)) {
      files[name.replace(/(\.tsx?)$/, ".test$1")] = "export {};";
    }
  }
  return files;
}

function policyViolations(
  moduleRoot: string,
  libraryRoot: string,
  basename: string,
  layout: string,
  source: string,
) {
  const movie = `${moduleRoot}/movie`;
  const entry = `${movie}/${basename}`;
  const privateFile = `${movie}/private.tsx`;
  // All six rules run together through the actual recommended consumer command.
  // Distinct locations prevent one rule's finding from qualifying another violation.
  const files: Record<string, string> = {};
  const expected: { filename: string; line: number; rule: string }[] = [];
  function violation(filename: string, source: string, rule: string, line = 1) {
    files[filename] = source;
    expected.push({ filename, line, rule });
  }

  for (const [index, specifier] of [
    `./${privateFile}`,
    `./${privateFile.slice(0, -4)}`,
    `external-${layout}/${privateFile}`,
    ...(layout === "alternate" ? ["@/features/movie/private.tsx"] : []),
  ].entries()) {
    violation(
      `private-${index}.test.ts`,
      `export type Id = import("${specifier}").Id;`,
      "module-imports",
    );
  }
  violation(
    "private.config.ts",
    `export type Id = import("./${privateFile}").Id;`,
    "module-imports",
  );
  violation("nested.test.ts", `import "./${movie}/media/${basename}";`, "module-imports");
  violation(
    `${libraryRoot}/probe.ts`,
    `export type Id = import("external-${layout}/${privateFile}").Id;`,
    "lib-imports",
  );
  violation(
    `${moduleRoot}/invalid/${basename}`,
    "export const Invalid = { play() {} }; export const play = () => 1;",
    "module-interface",
  );
  violation(
    `${movie}/mock.test.ts`,
    `import * as Test from "bun:test"; Test.mock["module"]("./${basename}", () => ({}));`,
    "public-collaborator-mocks",
  );
  violation(
    "private-mock.test.ts",
    `import { mock } from "bun:test"; mock.module("./${privateFile}", () => ({}));`,
    "public-collaborator-mocks",
  );
  violation(
    "opaque-mock.test.ts",
    'import { mock } from "bun:test"; mock.module(getTarget(), () => ({}));',
    "public-collaborator-mocks",
  );
  violation(
    `${movie}/descendant.test.ts`,
    `import { mock } from "bun:test"; mock.module("./media/${basename}", () => ({}));`,
    "public-collaborator-mocks",
  );
  violation(
    `${movie}/commands/private-mock.test.ts`,
    `import { mock } from "bun:test"; mock.module("../selectors/predicates.ts", () => ({}));`,
    "public-collaborator-mocks",
  );
  const split = source.replace(
    `import { queryOptions, mutationOptions } from "./query-options/${basename}";`,
    `import { queryOptions } from "./query-options/${basename}";\nimport { mutationOptions } from "./commands/${basename}";`,
  );
  files[entry] = split;
  expected.push({
    filename: entry,
    line: split.split("\n").findIndex((line) => line.includes("export const Movie =")) + 1,
    rule: "query-options-owner",
  });
  violation(
    `${moduleRoot}/local-query/${basename}`,
    "export const LocalQuery = { queryOptions: { find() {} }, mutationOptions: { save() {} } };",
    "query-options-owner",
  );
  violation(
    `${movie}/selectors/async.ts`,
    "export async function isReleased() { return true; }",
    "synchronous-selectors",
  );
  return { files, expected };
}

function assertFindings(
  stdout: string,
  expected: { filename: string; line: number; rule: string }[],
) {
  const diagnostics = report.parse(JSON.parse(stdout)).diagnostics;
  expect(
    diagnostics
      .map((item) => ({
        filename: item.filename,
        line: item.labels[0]?.span.line,
        rule: item.code,
      }))
      .toSorted((a, b) => a.filename.localeCompare(b.filename)),
  ).toEqual(
    expected
      .map((item) => ({ ...item, rule: `deep-modules(${item.rule})` }))
      .toSorted((a, b) => a.filename.localeCompare(b.filename)),
  );
  return diagnostics;
}

async function checkConsumer(
  consumer: string,
  runtime: string,
  moduleRoot: string,
  libraryRoot: string,
  basename: string,
  layout: string,
) {
  const lintArgs = [
    runtime,
    "node_modules/oxlint/bin/oxlint",
    "--deny-warnings",
    "--format",
    "json",
    ".",
  ];
  const structureArgs = [runtime, "node_modules/.bin/deep-modules-structure"];
  async function clean() {
    const lint = await command(consumer, lintArgs);
    expect({
      code: lint.exitCode,
      diagnostics: report.parse(JSON.parse(lint.stdout)).diagnostics,
    }).toEqual({ code: 0, diagnostics: [] });
    expect(await command(consumer, structureArgs)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  }

  const movie = `${moduleRoot}/movie`;
  const entry = `${movie}/${basename}`;
  const source = await Bun.file(path.join(consumer, entry)).text();
  await clean();
  const { files, expected } = policyViolations(moduleRoot, libraryRoot, basename, layout, source);
  await withFiles(consumer, files, async () => {
    const result = await command(consumer, lintArgs);
    expect(result.exitCode).toBe(1);
    const diagnostics = assertFindings(result.stdout, expected);
    for (const diagnostic of diagnostics) {
      const url = diagnostic.message.match(/file:\/\/[^\s]+\.md/)?.[0];
      expect(url).toContain("node_modules/@fveracoechea/oxlint-plugin-deep-modules/docs/");
      if (url)
        expect(await Bun.file(new URL(url)).text()).toContain(
          diagnostic.code.replace("(", "/").replace(")", ""),
        );
    }
  });
  await clean();

  for (const [changes, location, message] of [
    [
      { [entry.replace(/(\.tsx?)$/, ".test$1")]: null },
      entry.replace(/(\.tsx?)$/, ".test$1"),
      `entry ${basename} requires a corresponding behavior beside-test`,
    ],
    [{ [entry]: null }, entry, "every module requires one public interface"],
    [
      { [`${movie}/media/${basename}`]: null },
      `${movie}/media/${basename}`,
      "every module requires one public interface",
    ],
    [{ "misplaced.tsx": "export {};" }, "misplaced.tsx", "production TypeScript must live"],
  ] as const) {
    await withFiles(consumer, changes, async () => {
      const result = await command(consumer, structureArgs);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${location}: ${message}`);
      const url = result.stderr.match(/file:\/\/[^\s]+\.md/)?.[0];
      expect(url).toContain(
        "node_modules/@fveracoechea/oxlint-plugin-deep-modules/docs/structure.md",
      );
      if (url) expect(await Bun.file(new URL(url)).text()).toContain("entry");
    });
    await clean();
  }

  // Shared Media becomes its own top-level owner when both features need it.
  const sharedEntry = `${moduleRoot}/media/${basename}`;
  const localMedia = `${movie}/media/${basename}`;
  const localTest = localMedia.replace(/(\.tsx?)$/, ".test$1");
  const sharedTest = sharedEntry.replace(/(\.tsx?)$/, ".test$1");
  await withFiles(
    consumer,
    {
      [localMedia]: null,
      [localTest]: null,
      [`${movie}/media/private.ts`]: null,
      [sharedEntry]: await Bun.file(path.join(consumer, localMedia)).text(),
      [sharedTest]: "export {};",
      [entry]: source.replace(`"./media/${basename}"`, `"../media/${basename}"`),
      [`${moduleRoot}/tv-shows/${basename}`]: `import { Media } from "../media/${basename}"; export const TvShows = { play: Media.play };`,
      "public-mock.test.ts": `import * as Test from "bun:test"; Test.mock["module"]("./${sharedEntry}", () => ({}));`,
      [`${movie}/media-mock.test.ts`]: `import { mock } from "bun:test"; mock.module("external-client", () => ({}));`,
      [`${movie}/commands/mock.test.ts`]: `import { mock } from "bun:test"; mock.module("../selectors/${basename}", () => ({}));`,
    },
    clean,
  );
  await clean();

  // Returned async predicates must also fail through imported namespace composition.
  await withFiles(
    consumer,
    {
      [`${movie}/selectors/predicates.ts`]:
        "export const budgetIsBiggerThan = (minimum: number) => async (movie: {budget: number}) => movie.budget > minimum;",
    },
    async () => {
      const result = await command(consumer, [...lintArgs.slice(0, -1), entry]);
      expect(result.exitCode).toBe(1);
      const diagnostics = report.parse(JSON.parse(result.stdout)).diagnostics;
      expect(diagnostics.map((item) => item.code)).toEqual(["deep-modules(synchronous-selectors)"]);
      expect(diagnostics[0]?.filename).toBe(entry);
      expect(diagnostics[0]?.labels[0]?.span.line).toBeGreaterThan(0);
    },
  );
  await clean();
}

const check = lintProject();
test("consumer probes restore replaced source and configuration after a rejected probe", async () => {
  const consumer = await mkdtemp(path.join(tmpdir(), "deep-modules-rollback-"));
  roots.push(consumer);
  await Bun.write(path.join(consumer, ".oxlintrc.json"), '{"settings": {}}');
  await Bun.write(path.join(consumer, "main.ts"), "original");
  await expect(
    withFiles(
      consumer,
      {
        ".oxlintrc.json": '{"settings": {"typo": true}}',
        "main.ts": null,
        "child/private.ts": "invalid",
      },
      () => Promise.reject(new Error("probe failed")),
    ),
  ).rejects.toThrow("probe failed");
  expect(await Bun.file(path.join(consumer, ".oxlintrc.json")).text()).toBe('{"settings": {}}');
  expect(await Bun.file(path.join(consumer, "main.ts")).text()).toBe("original");
  expect(await Bun.file(path.join(consumer, "child/private.ts")).exists()).toBe(false);
  await expect(lstat(path.join(consumer, "child"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["default", "alternate"])(
  "source policy validates the complete %s consumer graph and exact negative locations",
  async (layout) => {
    const moduleRoot = layout === "default" ? "src/modules" : "web/features";
    const libraryRoot = layout === "default" ? "src/lib" : "web/shared";
    const basename = layout === "default" ? "main.ts" : "interface.ts";
    const baseline = movieProject(moduleRoot, basename);
    const entry = `${moduleRoot}/movie/${basename}`;
    const policy = JSON.stringify({
      ...recommended,
      plugins: ["oxc"],
      jsPlugins: [{ name: "deep-modules", specifier: "./packages/deep-modules/src/index.ts" }],
      rules: { ...recommended.rules, "oxc/no-barrel-file": "error" },
      settings: {
        "deep-modules": {
          moduleRoots: [moduleRoot],
          libraryRoots: [libraryRoot],
          objectEntries: [basename],
          aliases: { "@": "web" },
        },
      },
    });
    const source = baseline[entry] ?? "";
    const caller = baseline["consumer.test.ts"] ?? "";
    const options = {
      path: "consumer.test.ts",
      files: {
        ...baseline,
        ".oxlintrc.json": policy,
        "package.json": JSON.stringify({ name: `external-${layout}`, type: "module" }),
      },
    };
    expect((await check(caller, options)).codes).toEqual([]);
    const { files, expected } = policyViolations(moduleRoot, libraryRoot, basename, layout, source);
    const negative = await check(caller, {
      path: "consumer.test.ts",
      files: { ...options.files, ...files },
    });
    expect(negative.exitCode).toBe(1);
    assertFindings(negative.stdout, expected);
    expect((await check(caller, options)).codes).toEqual([]);
    const promoted = { ...baseline };
    for (const name of Object.keys(promoted))
      if (name.startsWith(`${moduleRoot}/movie/media/`)) delete promoted[name];
    const sharedEntry = `${moduleRoot}/media/${basename}`;
    promoted[sharedEntry] = baseline[`${moduleRoot}/movie/media/${basename}`] ?? "";
    promoted[sharedEntry.replace(/(\.tsx?)$/, ".test$1")] = "export {};";
    promoted[entry] = source.replace(`"./media/${basename}"`, `"../media/${basename}"`);
    promoted[`${moduleRoot}/tv-shows/${basename}`] =
      `import { Media } from "../media/${basename}"; export const TvShows = { play: Media.play };`;
    expect(
      (
        await check(caller, {
          path: "consumer.test.ts",
          files: { ...promoted, ".oxlintrc.json": policy },
        })
      ).codes,
    ).toEqual([]);
    expect((await check(caller, options)).codes).toEqual([]);
  },
);

const packageFiles = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/configuration.d.ts",
  "dist/structure-command.js",
  "recommended.json",
  "LICENSE",
  "README.md",
  "docs/module-interface.md",
  "docs/module-imports.md",
  "docs/lib-imports.md",
  "docs/public-collaborator-mocks.md",
  "docs/query-options-owner.md",
  "docs/structure.md",
  "docs/synchronous-selectors.md",
];

async function auditPackage(packageRoot: string) {
  expect((await lstat(packageRoot)).isSymbolicLink()).toBe(false);
  for (const file of packageFiles)
    expect(await Bun.file(path.join(packageRoot, file)).exists()).toBe(true);
  expect(await Bun.file(path.join(packageRoot, "src/index.ts")).exists()).toBe(false);
  expect(await Bun.file(path.join(packageRoot, "dist/structure-command.js")).text()).toStartWith(
    "#!/usr/bin/env node\n",
  );
  for await (const name of new Bun.Glob("dist/**/*.js").scan({ cwd: packageRoot })) {
    expect(await Bun.file(path.join(packageRoot, name.replace(/\.js$/, ".d.ts"))).exists()).toBe(
      true,
    );
    const source = await Bun.file(path.join(packageRoot, name)).text();
    // scanImports rejects executable hashbangs; normalize only its in-memory input.
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(
      source.replace(/^#![^\r\n]*/, ""),
    );
    for (const dependency of imports) {
      expect(dependency.path).not.toContain("operator");
      expect(dependency.path).not.toContain("/src/");
      expect(path.isAbsolute(dependency.path)).toBe(false);
      if (dependency.path.startsWith("."))
        expect(
          await Bun.file(path.resolve(packageRoot, path.dirname(name), dependency.path)).exists(),
        ).toBe(true);
    }
  }
}

test("artifact audit accepts executable hashbangs without hiding unsafe imports", async () => {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "deep-modules-artifact-"));
  roots.push(packageRoot);
  for (const file of packageFiles) await Bun.write(path.join(packageRoot, file), "");
  await Bun.write(path.join(packageRoot, "dist/structure-command.d.ts"), "");
  const commandFile = path.join(packageRoot, "dist/structure-command.js");
  const safeSource = '#!/usr/bin/env node\nimport "./index.js";\n';
  await Bun.write(commandFile, safeSource);
  await auditPackage(packageRoot);
  expect(await Bun.file(commandFile).text()).toBe(safeSource);
  for (const dependency of ["operator", "../src/private.js", "/absolute.js", "./missing.js"]) {
    await Bun.write(commandFile, `#!/usr/bin/env node\nimport "${dependency}";\n`);
    await expect(auditPackage(packageRoot)).rejects.toThrow();
  }
});

function consumerSettings(layout: string) {
  if (layout === "default") return { "deep-modules": { allowedFiles: ["contract.ts"] } };
  return {
    "deep-modules": {
      applicationRoots: ["web"],
      moduleRoots: ["web/features"],
      libraryRoots: ["web/shared"],
      aliases: { "@": "web" },
      objectEntries: ["interface.ts"],
      allowedFiles: ["contract.ts"],
    },
  };
}

test("packed policy accepts Movie/Media composition and rejects every rule and structure violation under Node and Bun", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deep-modules-installed-"));
  roots.push(root);
  const tarball = path.join(root, "plugin.tgz");
  const packed = await command(path.resolve(import.meta.dir, ".."), [
    process.execPath,
    "pm",
    "pack",
    "--filename",
    tarball,
  ]);
  expect({ code: packed.exitCode, error: packed.exitCode === 0 ? "" : packed.stderr }).toEqual({
    code: 0,
    error: "",
  });
  for (const layout of ["default", "alternate"]) {
    const consumer = path.join(root, layout);
    await Bun.write(path.join(consumer, ".gitignore"), "node_modules/\n");
    await Bun.write(
      path.join(consumer, "package.json"),
      JSON.stringify({
        name: `external-${layout}`,
        type: "module",
        private: true,
        devDependencies: {
          "@fveracoechea/oxlint-plugin-deep-modules": tarball,
          oxlint: "1.93.0",
          "@oxlint/plugins": "1.93.0",
          typescript: "7.0.2",
        },
      }),
    );
    const installed = await command(consumer, [process.execPath, "install", "--ignore-scripts"]);
    expect({
      code: installed.exitCode,
      error: installed.exitCode === 0 ? "" : installed.stderr,
    }).toEqual({ code: 0, error: "" });
    const packageRoot = path.join(
      consumer,
      "node_modules/@fveracoechea/oxlint-plugin-deep-modules",
    );
    await auditPackage(packageRoot);
    const moduleRoot = layout === "default" ? "src/modules" : "web/features";
    const libraryRoot = layout === "default" ? "src/lib" : "web/shared";
    const basename = layout === "default" ? "main.ts" : "interface.ts";
    await Bun.write(
      path.join(consumer, ".oxlintrc.json"),
      JSON.stringify({
        extends: ["./node_modules/@fveracoechea/oxlint-plugin-deep-modules/recommended.json"],
        plugins: ["oxc"],
        rules: { "oxc/no-barrel-file": "error" },
        settings: consumerSettings(layout),
      }),
    );
    const baseline = movieProject(moduleRoot, basename);
    for (const [name, source] of Object.entries(baseline))
      await Bun.write(path.join(consumer, name), source);
    await Bun.write(
      path.join(consumer, "contract.ts"),
      `
import plugin from "@fveracoechea/oxlint-plugin-deep-modules";
import { normalizeProjectConfig, type ProjectConfig } from "@fveracoechea/oxlint-plugin-deep-modules/configuration";
const config: ProjectConfig = normalizeProjectConfig({}, "/consumer");
console.log(plugin, config.moduleRoots);
`,
    );
    const declarations = await command(consumer, [
      process.execPath,
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--target",
      "es2023",
      "contract.ts",
    ]);
    expect({
      code: declarations.exitCode,
      error: declarations.exitCode === 0 ? "" : declarations.stdout,
    }).toEqual({ code: 0, error: "" });
    for (const runtime of ["node", process.execPath]) {
      await checkConsumer(consumer, runtime, moduleRoot, libraryRoot, basename, layout);
      for (const [name, source] of Object.entries(baseline))
        expect(await Bun.file(path.join(consumer, name)).text()).toBe(source);
      const sourceFiles = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: consumer }));
      sourceFiles.push(
        ...(await Array.fromAsync(
          new Bun.Glob(`${moduleRoot.split("/")[0]}/**/*.{ts,tsx}`).scan({ cwd: consumer }),
        )),
      );
      expect(sourceFiles.toSorted()).toEqual([...Object.keys(baseline), "contract.ts"].toSorted());
    }
  }
}, 120_000);
