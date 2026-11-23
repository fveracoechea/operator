// The portable command runs under Node as well as Bun.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { normalizeProjectConfig, type ProjectConfig } from "./configuration.ts";
import { contains, discoverOwners, excluded, ownerOf, productionFile } from "./project.ts";

const guidance = new URL("../docs/structure.md", import.meta.url).href;

function besideTest(entry: string, files: Set<string>): boolean {
  const extension = path.extname(entry);
  const stem = entry.slice(0, -extension.length);
  return [...files].some((file) => {
    if (!file.startsWith(`${stem}.`) || !file.endsWith(`.test${extension}`)) return false;
    const testStem = file.slice(0, -`.test${extension}`.length);
    return ![...files].some((other) => {
      if (!productionFile(other) || !other.endsWith(extension)) return false;
      const otherStem = other.slice(0, -extension.length);
      return (
        otherStem.length > stem.length &&
        (testStem === otherStem || testStem.startsWith(`${otherStem}.`))
      );
    });
  });
}

export function checkStructure(config: ProjectConfig): string[] {
  const errors: string[] = [];
  const owners = discoverOwners(config);
  function report(filename: string, message: string) {
    errors.push(
      `${path.relative(config.projectRoot, filename)}: ${message} [deep-modules/structure] ${guidance}`,
    );
  }

  function visit(directory: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.name.startsWith(".") || item.name === "node_modules" || excluded(filename, config))
        continue;
      if (config.toolingRoots.some((root) => contains(root, filename))) continue;
      if (item.isDirectory()) visit(filename);
      if (
        !item.isFile() ||
        !productionFile(filename) ||
        item.name.endsWith(".config.ts") ||
        config.allowedFiles.includes(filename)
      )
        continue;
      if (config.libraryRoots.some((root) => contains(root, filename))) continue;
      if (ownerOf(filename, owners)) continue;
      report(
        filename,
        config.moduleRoots.some((root) => contains(root, filename))
          ? "production files must be inside a feature module"
          : "production TypeScript must live in a configured module, library or tooling location",
      );
    }
  }

  visit(config.projectRoot);
  for (const owner of owners) {
    const files = new Set(
      readdirSync(owner, { withFileTypes: true })
        .filter((file) => file.isFile() && !excluded(path.join(owner, file.name), config))
        .map((file) => file.name),
    );
    const entries = [...config.objectEntries, ...config.frameworkEntries].filter((entry) =>
      files.has(entry),
    );
    const behavior = [...files].filter(productionFile);
    const schemaOnly =
      behavior.length > 0 && behavior.every((file) => config.schemaEntries.includes(file));
    if (entries.length === 0 && !schemaOnly)
      errors.push(
        `${path.relative(config.projectRoot, path.join(owner, config.objectEntries[0] ?? "main.ts"))}: every module requires one public interface [deep-modules/structure] ${guidance}`,
      );
    for (const entry of entries) {
      if (!besideTest(entry, files))
        errors.push(
          `${path.relative(config.projectRoot, path.join(owner, entry.replace(/(\.tsx?)$/, ".test$1")))}: entry ${entry} requires a corresponding behavior beside-test [deep-modules/structure] ${guidance}`,
        );
    }
  }
  return errors.toSorted();
}

const consumerConfiguration = z.object({
  settings: z.record(z.string(), z.json()).default({}),
  extends: z.array(z.string()).default([]),
});

function readSettings(
  filename: string,
  seen = new Set<string>(),
): ReturnType<typeof consumerConfiguration.parse>["settings"] {
  if (seen.has(filename)) return z.never({ error: "configuration cycle" }).parse(null);
  const next = new Set([...seen, filename]);
  const input = consumerConfiguration.parse(JSON.parse(readFileSync(filename, "utf8")));
  const settings: ReturnType<typeof consumerConfiguration.parse>["settings"] = {};
  for (const extension of input.extends) {
    const inherited = extension.startsWith(".")
      ? path.resolve(path.dirname(filename), extension)
      : createRequire(filename).resolve(extension);
    Object.assign(settings, readSettings(inherited, next));
  }
  return { ...settings, ...input.settings };
}

export function runStructureCommand(args: string[], cwd: string): number {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--config")) {
    console.error(
      `deep-modules/structure: usage: deep-modules-structure [--config .oxlintrc.json] ${guidance}`,
    );
    return 2;
  }
  try {
    const configPath = path.resolve(cwd, args[1] ?? ".oxlintrc.json");
    const settings =
      args.length === 0 && !statSync(configPath, { throwIfNoEntry: false })
        ? {}
        : readSettings(configPath);
    const errors = checkStructure(normalizeProjectConfig(settings, cwd));
    for (const error of errors) console.error(error);
    return errors.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Error)) return 2;
    console.error(`deep-modules/structure: ${error.message} ${guidance}`);
    return 2;
  }
}
