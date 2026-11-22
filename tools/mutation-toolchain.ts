// Bun has no directory metadata or real-path API.
import { stat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const packageManifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

async function hashFiles(files: string[], tools: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  const named = files.map((file) => [path.relative(tools, file), file] as const);
  // Stryker disable next-line ArrowFunction: no rule: deterministic traversal order only changes the opaque digest; every named byte and file mode still participates
  for (const [name, file] of named.toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const metadata = await stat(file);
    hash.update(JSON.stringify([name, metadata.mode]));
    if (!metadata.isFile())
      return Promise.reject(new Error(`Unsupported installed input: ${file}`));
    hash.update(await Bun.file(file).bytes());
  }
  return hash.digest("hex");
}

export async function mutationToolchainIdentity(
  tools = import.meta.dir,
  runtime = process.execPath,
): Promise<string> {
  const files = new Set<string>([runtime]);
  const packages = new Set<string>();
  async function installed(name: string, from: string, optional = false): Promise<void> {
    let ancestor = from;
    let directory = path.join(ancestor, "node_modules", name);
    while (!(await Bun.file(path.join(directory, "package.json")).exists())) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        if (optional) return;
        return Promise.reject(new Error(`Unresolved installed dependency: ${name}`));
      }
      ancestor = parent;
      directory = path.join(ancestor, "node_modules", name);
    }
    directory = await realpath(directory);
    if (packages.has(directory)) return;
    packages.add(directory);
    async function walk(folder: string): Promise<void> {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file);
        else files.add(file);
      }
    }

    await walk(directory);
    const manifest = packageManifest.parse(
      await Bun.file(path.join(directory, "package.json")).json(),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await installed(dependency, directory);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      await installed(dependency, directory, true);
  }

  for (const name of ["@stryker-mutator/core", "@babel/parser", "@babel/types", "zod"])
    await installed(name, tools);
  for (const entry of await readdir(tools))
    if ((entry.startsWith("mutation-") || entry === "mutate.ts") && !entry.endsWith(".test.ts"))
      files.add(path.join(tools, entry));
  return hashFiles([...files], tools);
}
