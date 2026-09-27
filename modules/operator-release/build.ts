// Bun has no directory creation, removal, or path manipulation API.
import { mkdir, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { OperatorConfig } from "../operator-config/main.ts";
import { identifyArtifact, RELEASE_MANIFEST_PATH, scanFiles } from "./inventory.ts";
import { rewriteSpecifiers } from "./specifiers.ts";

const ENTRY_POINT = "cli.ts";
const README_SOURCE = "docs/jsr/README.md";

/** The transpiler refuses a shebang, so the executable line travels beside the source it leads. */
function splitShebang(text: string): { shebang: string; body: string } {
  const end = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
  return { shebang: text.slice(0, end), body: text.slice(end) };
}

/** The transpiler drops JSDoc, so restore the public entry point's comments in shipped JS. */
function documentEntryPoint(source: string, compiled: string): string {
  const docs = [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)];
  const moduleDoc = docs.find((match) => match[0].includes("@module"))?.[0];
  const mainDoc = docs.find((match) =>
    source.slice(match.index + match[0].length).startsWith("\nexport async function main("),
  )?.[0];
  if (!moduleDoc || !mainDoc || !compiled.includes("export async function main(")) {
    throw new Error("The CLI entry point must document its module and main function.");
  }
  return `${moduleDoc}\n${compiled.replace("export async function main(", `${mainDoc}\nexport async function main(`)}`;
}
const SKILLS_DIRECTORY = "skills";
const HERDR_DIRECTORY = "herdr";

/** The fields of the source manifest a release carries forward into what it publishes. */
const sourceManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1),
  engines: z.object({ bun: z.string().min(1) }),
  dependencies: z.record(z.string(), z.string()),
});

type SourceManifest = z.infer<typeof sourceManifestSchema>;

async function readSourceManifest(sourceRoot: string): Promise<SourceManifest> {
  return sourceManifestSchema.parse(await Bun.file(`${sourceRoot}/package.json`).json());
}

/**
 * The files the command entry point actually reaches.
 * Following the imports ships exactly what the release runs, so a test double or a fixture that
 * only a test imports never becomes part of a published version.
 */
async function reachableSources(sourceRoot: string): Promise<string[]> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const reached = new Set<string>();
  const pending = [ENTRY_POINT];

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || reached.has(path)) {
      continue;
    }
    reached.add(path);

    const source = splitShebang(await Bun.file(`${sourceRoot}/${path}`).text()).body;
    for (const found of transpiler.scanImports(source)) {
      if (!found.path.startsWith(".") || !found.path.endsWith(".ts")) {
        continue;
      }
      pending.push(relative(sourceRoot, resolve(dirname(`${sourceRoot}/${path}`), found.path)));
    }
  }

  return [...reached].toSorted();
}

async function writeDeclarations(request: {
  sourceRoot: string;
  artifactRoot: string;
  sources: string[];
}): Promise<{ status: "emitted" } | { status: "failed"; detail: string }> {
  const configPath = `${request.artifactRoot}.tsconfig.json`;
  await Bun.write(
    configPath,
    `${JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ESNext",
        strict: true,
        skipLibCheck: true,
        types: ["bun"],
        typeRoots: [`${request.sourceRoot}/node_modules/@types`],
        rootDir: request.sourceRoot,
        outDir: request.artifactRoot,
      },
      files: request.sources.map((path) => `${request.sourceRoot}/${path}`),
    })}\n`,
  );

  try {
    const child = Bun.spawn(["bunx", "--bun", "--no-install", "tsc", "-p", configPath], {
      cwd: request.sourceRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) {
      return { status: "failed", detail: `${stdout}${stderr}`.trim() };
    }
  } finally {
    await rm(configPath, { force: true });
  }

  // The declarations name their neighbours by the source extension, so they are rewritten too.
  for (const path of await scanFiles(request.artifactRoot)) {
    if (!path.endsWith(".d.ts")) {
      continue;
    }
    const file = `${request.artifactRoot}/${path}`;
    await Bun.write(file, rewriteSpecifiers(await Bun.file(file).text()));
  }

  return { status: "emitted" };
}

function packageManifest(source: SourceManifest): string {
  return `${JSON.stringify(
    {
      name: source.name,
      version: source.version,
      license: source.license,
      type: "module",
      bin: { operator: "./cli.js" },
      exports: {
        ".": { types: "./cli.d.ts", default: "./cli.js" },
        "./cli": { types: "./cli.d.ts", default: "./cli.js" },
        "./package.json": "./package.json",
      },
      engines: source.engines,
      dependencies: source.dependencies,
    },
    null,
    2,
  )}\n`;
}

/**
 * The configuration the registry reads.
 * The registry generates the published package manifest from this file, so every package the
 * shipped code reaches is named here at its exact version. A dependency named only in the
 * package manifest beside it would be absent from a published copy.
 */
function jsrManifest(source: SourceManifest): string {
  const imports = Object.fromEntries(
    Object.entries(source.dependencies).map(([name, version]) => [name, `npm:${name}@${version}`]),
  );

  return `${JSON.stringify(
    {
      name: source.name,
      version: source.version,
      license: source.license,
      exports: { "./cli": "./cli.js" },
      imports,
    },
    null,
    2,
  )}\n`;
}

/**
 * Writes one release artifact from one checkout.
 * It holds runnable ESM, declarations, owned skills, the Herdr plugin, and the generated
 * configuration schema, so retrieval never runs a build of its own.
 */
export async function buildArtifact(request: {
  sourceRoot: string;
  artifactRoot: string;
  commit: string;
  now?: string;
}) {
  const sourceRoot = request.sourceRoot.replace(/\/$/, "");
  const artifactRoot = request.artifactRoot.replace(/\/$/, "");
  await rm(artifactRoot, { force: true, recursive: true });
  await mkdir(artifactRoot, { recursive: true });

  const source = await readSourceManifest(sourceRoot);
  const sources = await reachableSources(sourceRoot);
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });

  for (const path of sources) {
    const { shebang, body } = splitShebang(await Bun.file(`${sourceRoot}/${path}`).text());
    const compiled = rewriteSpecifiers(transpiler.transformSync(body));
    await Bun.write(
      `${artifactRoot}/${path.replace(/\.ts$/, ".js")}`,
      `${shebang}${path === ENTRY_POINT ? documentEntryPoint(body, compiled) : compiled}`,
      { createPath: true },
    );
  }

  const declarations = await writeDeclarations({ sourceRoot, artifactRoot, sources });
  if (declarations.status === "failed") {
    return { status: "declaration-failed" as const, detail: declarations.detail };
  }

  for (const directory of [SKILLS_DIRECTORY, HERDR_DIRECTORY]) {
    for (const path of await scanFiles(`${sourceRoot}/${directory}`)) {
      await Bun.write(
        `${artifactRoot}/${directory}/${path}`,
        Bun.file(`${sourceRoot}/${directory}/${path}`),
        { createPath: true },
      );
    }
  }

  await Bun.write(`${artifactRoot}/config.schema.json`, OperatorConfig.jsonSchemaText());
  await Bun.write(`${artifactRoot}/README.md`, Bun.file(`${sourceRoot}/${README_SOURCE}`));
  await Bun.write(`${artifactRoot}/package.json`, packageManifest(source));
  await Bun.write(`${artifactRoot}/jsr.json`, jsrManifest(source));

  // The identity covers every published byte. The record of it is written afterwards, so the
  // artifact it names is exactly what a consumer receives.
  const artifactIdentity = await identifyArtifact(artifactRoot);
  await Bun.write(
    `${artifactRoot}/${RELEASE_MANIFEST_PATH}`,
    `${JSON.stringify(
      {
        version: source.version,
        commit: request.commit,
        supportedBun: source.engines.bun,
        builtAt: request.now ?? new Date().toISOString(),
        artifactIdentity,
      },
      null,
      2,
    )}\n`,
  );

  return { status: "built" as const, artifactRoot, artifactIdentity, files: sources.length };
}
