import { OperatorRelease } from "../operator-release/main.ts";
import type { TarEntry } from "./tar.ts";

/** Reads every published byte of one artifact, under the names it is delivered as. */
export async function scanArtifact(artifactRoot: string, prefix: string): Promise<TarEntry[]> {
  const root = artifactRoot.replace(/\/$/, "");
  const paths = await OperatorRelease.contents({ artifactRoot: root });

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
