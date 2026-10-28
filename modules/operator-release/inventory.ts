export const RELEASE_MANIFEST_PATH = "release.json";
export const SETTINGS_SCHEMA_PATH = "schemas/config.schema.json";
export const HERDR_PLUGIN_PATH = "modules/worker-dispatch/herdr-plugin.toml";

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
    // oxlint-disable-next-line unthrown/no-throw -- Only missing files are modeled here. Preserve unexpected I/O defects.
    throw error;
  }
}

/**
 * Identifies an artifact by the exact bytes it holds under the exact names it publishes them as.
 * Changed content is a different release, including on a delivery retry.
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
  "README.md",
  "cli.js",
  "cli.d.ts",
  "package.json",
  "jsr.json",
  "release.json",
  SETTINGS_SCHEMA_PATH,
  HERDR_PLUGIN_PATH,
  "modules/operator-cli/main.js",
  "modules/operator-cli/main.d.ts",
  "modules/device-state/migrations/0000_register_projects.sql",
  "modules/device-state/migrations/meta/_journal.json",
  "skills/deep-modules/SKILL.md",
  "skills/pr-review/DESIGN.md",
  "skills/pr-review/SKILL.md",
  "skills/pr-review/draft.md",
  "skills/slack-pr-review-workflow/SKILL.md",
  "skills/super-agent/SKILL.md",
  "skills/super-agent/delegation.md",
  "skills/super-agent/dispatch.md",
  "skills/super-agent/reports.md",
  "skills/super-agent/reviews.md",
  "skills/super-agent/setup.md",
  "skills/worker-agent/SKILL.md",
  "skills/worker-agent/responsibility.md",
];
