import { SkillInstall } from "../skill-install/main.ts";
import { buildArtifact } from "./build.ts";
import { identifyArtifact, REQUIRED_PARTS, scanFiles } from "./inventory.ts";
import { packageRoot, installationRoot, readLockData, readReleaseManifest } from "./manifest.ts";

export const OperatorRelease = {
  /**
   * Reads what the release says about itself, with no reading of the skills it ships.
   * The command entry point checks the runtime before it does anything, so that check stays
   * cheap and never depends on scanning the bundled assets.
   */
  async manifest() {
    return readReleaseManifest();
  },

  /**
   * Reads the release this process runs as, wherever it was retrieved from.
   * The record a built artifact carries wins over the package manifest, because a registry
   * rewrites that manifest and drops the fields a published copy would be read from.
   */
  async identify() {
    const [manifest, lock, skillsIdentity] = await Promise.all([
      readReleaseManifest(),
      readLockData(),
      SkillInstall.identity(),
    ]);

    return {
      version: manifest.version,
      commit: manifest.commit,
      supportedBun: manifest.supportedBun,
      builtAt: manifest.builtAt,
      artifact: manifest.artifactIdentity === null ? ("checkout" as const) : ("built" as const),
      artifactIdentity: manifest.artifactIdentity,
      root: packageRoot,
      installationRoot: installationRoot(),
      skillsIdentity,
      // The identity covers the code version and the exact skills it installs, together.
      identity: new Bun.CryptoHasher("sha256")
        .update(`${manifest.version}\n${skillsIdentity}`)
        .digest("hex"),
      lock,
    };
  },

  /** Writes one release artifact from one checkout, with no install-time build for a consumer. */
  async build(request: { sourceRoot: string; artifactRoot: string; commit: string; now?: string }) {
    return buildArtifact(request);
  },

  /** The files one artifact holds, under the exact names it is published as. */
  async contents(request: { artifactRoot: string }) {
    return scanFiles(request.artifactRoot.replace(/\/$/, ""));
  },

  /** Reports whether one artifact directory holds every part a release must carry. */
  async inspect(request: { artifactRoot: string }) {
    const root = request.artifactRoot.replace(/\/$/, "");
    const present = await Promise.all(
      REQUIRED_PARTS.map(async (path) => ({
        path,
        found: await Bun.file(`${root}/${path}`).exists(),
      })),
    );
    const missing = present.filter((part) => !part.found).map((part) => part.path);

    return {
      status: missing.length === 0 ? ("complete" as const) : ("incomplete" as const),
      artifactRoot: root,
      artifactIdentity: await identifyArtifact(root),
      required: REQUIRED_PARTS,
      missing,
    };
  },
};
