import type { TarEntry } from "./tar.ts";

/** Lists every file under a directory, treating a missing directory as empty. */
async function scanFiles(directory: string): Promise<string[]> {
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

/** Reads every published byte of one artifact, under the names it is delivered as. */
export async function scanArtifact(artifactRoot: string, prefix: string): Promise<TarEntry[]> {
  const root = artifactRoot.replace(/\/$/, "");
  const paths = await scanFiles(root);

  return Promise.all(
    paths.map(async (path) => ({
      path: prefix === "" ? path : `${prefix}/${path}`,
      bytes: new Uint8Array(await Bun.file(`${root}/${path}`).arrayBuffer()),
      // The registry tarball is not trusted to keep a file mode, so the launcher never
      // depends on one. The executable bit is recorded for the command entry point alone.
      executable: path === "cli.js",
    })),
  );
}
