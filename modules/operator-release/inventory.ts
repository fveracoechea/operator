export const RELEASE_MANIFEST_PATH = "release.json";

export type ArtifactFile = { path: string; bytes: Uint8Array };

/** Lists every file under a directory, treating a missing directory as empty. */
export async function scanFiles(directory: string): Promise<string[]> {
  try {
    return (
      await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: directory, dot: true, onlyFiles: true }),
      )
    ).toSorted();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Identifies an artifact by the exact bytes it holds under the exact names it publishes them as.
 * Changed content is a different release, so this identity is what an approval is bound to.
 */
export async function identifyArtifact(artifactRoot: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of await scanFiles(artifactRoot)) {
    if (path === RELEASE_MANIFEST_PATH) {
      continue;
    }
    hasher.update(`${path}\n`);
    hasher.update(new Uint8Array(await Bun.file(`${artifactRoot}/${path}`).arrayBuffer()));
  }

  return hasher.digest("hex");
}

/** The parts a release must contain before either delivery path may carry it. */
export const REQUIRED_PARTS = [
  "cli.js",
  "cli.d.ts",
  "package.json",
  "jsr.json",
  "release.json",
  "config.schema.json",
  "modules/operator-cli/main.js",
  "modules/operator-cli/main.d.ts",
  "skills/operator/SKILL.md",
];
