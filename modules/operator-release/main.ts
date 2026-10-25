import { buildArtifact } from "./build.ts";
import { identifyArtifact, REQUIRED_PARTS, scanFiles } from "./inventory.ts";
import { readArtifactRelease, readReleaseManifest } from "./manifest.ts";

export const OperatorRelease = {
  /**
   * Reads what the release says about itself, with no reading of the skills it ships.
   * The command entry point checks the runtime before it does anything, so that check stays
   * cheap and never depends on scanning the bundled assets.
   */
  async manifest() {
    return readReleaseManifest();
  },

  /** Writes one release artifact from one checkout, with no install-time build for a consumer. */
  async build(request: { sourceRoot: string; artifactRoot: string; commit: string; now?: string }) {
    return buildArtifact(request);
  },

  /** The files one artifact holds, under the exact names it is published as. */
  async contents(request: { artifactRoot: string }) {
    return scanFiles(request.artifactRoot.replace(/\/$/, ""));
  },

  /**
   * Reports whether one artifact directory holds every part a release must carry, and the
   * version and commit its release record names.
   */
  async inspect(request: { artifactRoot: string }) {
    const root = request.artifactRoot.replace(/\/$/, "");
    const present = await Promise.all(
      REQUIRED_PARTS.map(async (path) => ({
        path,
        found: await Bun.file(`${root}/${path}`).exists(),
      })),
    );
    const missing = present.filter((part) => !part.found).map((part) => part.path);
    const { version, commit } = await readArtifactRelease(root);

    return {
      status: missing.length === 0 ? ("complete" as const) : ("incomplete" as const),
      artifactRoot: root,
      artifactIdentity: await identifyArtifact(root),
      required: REQUIRED_PARTS,
      missing,
      version,
      commit,
    };
  },
};
