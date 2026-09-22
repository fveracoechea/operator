// Bun has no directory creation, removal, or path manipulation API.
import { mkdir, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { OperatorConfig } from "../operator-config/main.ts";
import { identifyArtifact, RELEASE_MANIFEST_PATH, scanFiles } from "./inventory.ts";
import { rewriteSpecifiers } from "./specifiers.ts";

const ENTRY_POINT = "cli.ts";

/** The transpiler refuses a shebang, so the executable line travels beside the source it leads. */
function splitShebang(text: string): { shebang: string; body: string } {
  const end = text.startsWith("#!") ? text.indexOf("\n") + 1 : 0;
  return { shebang: text.slice(0, end), body: text.slice(end) };
}
const SKILLS_DIRECTORY = "skills";

type SourceManifest = {
  name: string;
  version: string;
  engines: { bun: string };
  dependencies: Record<string, string>;
};

async function readSourceManifest(sourceRoot: string): Promise<SourceManifest> {
  const parsed: unknown = await Bun.file(`${sourceRoot}/package.json`).json();
  const manifest = parsed as SourceManifest;
  return {
    name: manifest.name,
    version: manifest.version,
    engines: { bun: manifest.engines.bun },
    dependencies: manifest.dependencies,
  };
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

function jsrManifest(source: SourceManifest): string {
  return `${JSON.stringify(
    { name: source.name, version: source.version, exports: { "./cli": "./cli.js" } },
    null,
    2,
  )}\n`;
}

/**
 * Writes one release artifact from one checkout.
 * It holds runnable ESM, the public declarations, the complete owned-skill directories, and the
 * generated configuration schema, so retrieval never runs a build of its own.
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
    await Bun.write(`${artifactRoot}/${path.replace(/\.ts$/, ".js")}`, `${shebang}${compiled}`, {
      createPath: true,
    });
  }

  const declarations = await writeDeclarations({ sourceRoot, artifactRoot, sources });
  if (declarations.status === "failed") {
    return { status: "declaration-failed" as const, detail: declarations.detail };
  }

  for (const path of await scanFiles(`${sourceRoot}/${SKILLS_DIRECTORY}`)) {
    await Bun.write(
      `${artifactRoot}/${SKILLS_DIRECTORY}/${path}`,
      Bun.file(`${sourceRoot}/${SKILLS_DIRECTORY}/${path}`),
      { createPath: true },
    );
  }

  await Bun.write(`${artifactRoot}/config.schema.json`, OperatorConfig.jsonSchemaText());
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
