import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory, file metadata, or recursive removal API.
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

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

async function checkInstalledImports(
  consumer: string,
  runtime: string,
  entry: string,
  layout: string,
) {
  const privateFile = path.posix.join(path.posix.dirname(entry), "private.tsx");
  await Bun.write(path.join(consumer, privateFile), "export type Id = string;");
  const specifiers = [
    `./${privateFile}`,
    `./${privateFile.slice(0, -4)}`,
    `external-${layout}/${privateFile}`,
  ];
  if (layout === "alternate") specifiers.push("@/features/movie/private.tsx");
  for (const specifier of specifiers) {
    await Bun.write(
      path.join(consumer, "consumer.test.ts"),
      `export type Id = import("${specifier}").Id;`,
    );
    const result = await command(consumer, [
      runtime,
      "node_modules/oxlint/bin/oxlint",
      "--format",
      "json",
      "consumer.test.ts",
    ]);
    expect(result.exitCode).toBe(1);
    const diagnostics = report.parse(JSON.parse(result.stdout)).diagnostics;
    expect(diagnostics.map((item) => item.code)).toEqual(["deep-modules(module-imports)"]);
    expect(diagnostics[0]?.filename).toBe("consumer.test.ts");
    expect(diagnostics[0]?.labels[0]?.span.line).toBe(1);
    const url = diagnostics[0]?.message.match(/file:\/\/[^\s]+\.md/)?.[0];
    expect(url).toBeDefined();
    if (url) expect(await Bun.file(new URL(url)).text()).toContain("deep-modules/module-imports");
  }
  await Bun.write(path.join(consumer, "consumer.test.ts"), `import "./${entry}";`);
  expect(
    (
      await command(consumer, [
        runtime,
        "node_modules/oxlint/bin/oxlint",
        "--format",
        "json",
        "consumer.test.ts",
      ])
    ).exitCode,
  ).toBe(0);
  const library = layout === "default" ? "src/lib/probe.ts" : "web/shared/probe.ts";
  await Bun.write(
    path.join(consumer, library),
    `export type Id = import("external-${layout}/${privateFile}").Id;`,
  );
  const invalidLib = await command(consumer, [
    runtime,
    "node_modules/oxlint/bin/oxlint",
    "--format",
    "json",
    library,
  ]);
  expect(invalidLib.exitCode).toBe(1);
  const libDiagnostics = report.parse(JSON.parse(invalidLib.stdout)).diagnostics;
  expect(libDiagnostics.map((item) => item.code)).toEqual(["deep-modules(lib-imports)"]);
}

test("packed JavaScript, declarations, recommended config and guidance work outside Operator under Node and Bun", async () => {
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
    expect((await lstat(packageRoot)).isSymbolicLink()).toBe(false);
    for (const file of [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/configuration.d.ts",
      "LICENSE",
      "README.md",
      "docs/module-interface.md",
      "docs/module-imports.md",
      "docs/lib-imports.md",
    ])
      expect(await Bun.file(path.join(packageRoot, file)).exists()).toBe(true);
    expect(await Bun.file(path.join(packageRoot, "src/index.ts")).exists()).toBe(false);
    const entry =
      layout === "default" ? "src/modules/movie/main.ts" : "web/features/movie/interface.ts";
    const settings =
      layout === "alternate"
        ? {
            "deep-modules": {
              projectRoot: ".",
              applicationRoots: ["web"],
              moduleRoots: ["web/features"],
              libraryRoots: ["web/shared"],
              aliases: { "@": "web" },
              objectEntries: ["interface.ts"],
            },
          }
        : {};
    await Bun.write(
      path.join(consumer, ".oxlintrc.json"),
      JSON.stringify({
        extends: ["./node_modules/@fveracoechea/oxlint-plugin-deep-modules/recommended.json"],
        settings,
      }),
    );
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
      const args = [runtime, "node_modules/oxlint/bin/oxlint", "--format", "json", entry];
      await Bun.write(path.join(consumer, entry), "export const Movie = { play() {} };");
      expect((await command(consumer, args)).exitCode).toBe(0);
      await checkInstalledImports(consumer, runtime, entry, layout);
      await Bun.write(path.join(consumer, entry), "export const play = () => 1;");
      const invalid = await command(consumer, args);
      expect(invalid.exitCode).toBe(1);
      const diagnostics = report.parse(JSON.parse(invalid.stdout)).diagnostics;
      expect(
        diagnostics.some(
          (item) =>
            item.code === "deep-modules(module-interface)" &&
            item.filename === entry &&
            item.labels.some((label) => label.span.line === 1),
        ),
      ).toBe(true);
      for (const item of diagnostics) {
        const url = item.message.match(/file:\/\/[^\s]+\.md/)?.[0];
        expect(url).toBeDefined();
        if (url) {
          expect(url).toContain(packageRoot);
          expect(await Bun.file(new URL(url)).text()).toContain("deep-modules/module-interface");
        }
      }
    }
  }
}, 120_000);
