import type { Context } from "@oxlint/plugins";
// The distributed plugin cannot require Bun to resolve consumer paths.
import path from "node:path";
import { z } from "zod";

const root = z.string().min(1);
const entry = z.string().regex(/^[^/\\]+\.tsx?$/);
const configuration = z.strictObject({
  projectRoot: root.default("."),
  applicationRoots: z.array(root).min(1).default(["src"]),
  moduleRoots: z.array(root).min(1).default(["src/modules"]),
  libraryRoots: z.array(root).default(["src/lib"]),
  aliases: z.record(z.string().min(1), root).default({}),
  objectEntries: z
    .array(entry)
    .min(1)
    .default(["main.ts", "main.server.ts", "main.tsx", "main.server.tsx"]),
  schemaEntries: z.array(entry).default(["schemas.ts", "schemas.generated.ts"]),
  frameworkEntries: z.array(entry).default(["$functions.ts"]),
  exclusions: z.array(root).default([]),
});

export type ProjectConfig = z.infer<typeof configuration>;

/** The plugin and structure command receive the same Oxlint settings object. */
export function normalizeProjectConfig(settings: Context["settings"], cwd: string): ProjectConfig {
  const input = settings["deep-modules"];
  const config = configuration.parse(input === undefined ? {} : input);
  const projectRoot = path.resolve(cwd, config.projectRoot);
  function absolute(name: string) {
    return path.resolve(projectRoot, name);
  }

  return {
    ...config,
    projectRoot,
    applicationRoots: config.applicationRoots.map(absolute),
    moduleRoots: config.moduleRoots.map(absolute),
    libraryRoots: config.libraryRoots.map(absolute),
    aliases: Object.fromEntries(
      Object.entries(config.aliases).map(([name, target]) => [name, absolute(target)]),
    ),
    exclusions: config.exclusions.map(absolute),
  };
}
