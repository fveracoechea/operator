import { z } from "zod";
import {
  declaresRelease,
  JSR_PACKAGE_NAME,
  PACKAGE_NAME,
  PROJECT_SCRIPT,
  releaseSpecifier,
} from "./selection.ts";

const DEPENDENCY_GROUPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

// The worktree check reads only the operator script and lets devDependencies be absent, unlike
// the project check, because it compares each present dependency group with the lock.
const dependencyGroup = z.record(z.string(), z.string()).optional();
const manifestSchema = z.object({
  scripts: z.object({ operator: z.string() }),
  dependencies: dependencyGroup,
  devDependencies: dependencyGroup,
  optionalDependencies: dependencyGroup,
  peerDependencies: dependencyGroup,
});
const lockSchema = z.object({
  workspaces: z.object({
    "": z.object({
      dependencies: dependencyGroup,
      devDependencies: dependencyGroup,
      optionalDependencies: dependencyGroup,
      peerDependencies: dependencyGroup,
    }),
  }),
  packages: z.record(z.string(), z.array(z.unknown())),
});

type Manifest = z.infer<typeof manifestSchema>;

const UNREADABLE_LOCK =
  "The worktree bun.lock cannot be read. Regenerate it with Bun, commit it, and dispatch from that commit.";

/** The lock records each dependency group of the manifest and pins the selected JSR version. */
function lockMatches(manifest: Manifest, lockBytes: Uint8Array, version: string): string | null {
  let lockData: unknown;
  try {
    lockData = Bun.JSONC.parse(new TextDecoder().decode(lockBytes));
  } catch {
    return UNREADABLE_LOCK;
  }
  const locked = lockSchema.safeParse(lockData);
  if (!locked.success) return UNREADABLE_LOCK;
  for (const key of DEPENDENCY_GROUPS) {
    const declared = manifest[key] ?? {};
    const recorded = locked.data.workspaces[""][key] ?? {};
    if (!Bun.deepEquals(declared, recorded)) {
      return `The worktree package.json ${key} differs from bun.lock. Commit a frozen installation at the base commit before dispatch.`;
    }
  }
  if (locked.data.packages[PACKAGE_NAME]?.[0] !== `${JSR_PACKAGE_NAME}@${version}`) {
    return `The worktree bun.lock does not pin ${PACKAGE_NAME} at ${version}. Commit the selected JSR dependency before dispatch.`;
  }
  return null;
}

/** A frozen install must read the same manifest and lock at the launch base commit. */
export async function checkWorktreeInstallation(request: {
  worktreeRoot: string;
  version: string;
  lockName: string;
  lockBytes: Uint8Array;
}): Promise<string | null> {
  const manifestFile = Bun.file(`${request.worktreeRoot}/package.json`);
  const manifest = manifestSchema.safeParse(await manifestFile.json().catch(() => null));
  if (!manifest.success || !declaresRelease(manifest.data, request.version)) {
    return `The worktree base commit needs package.json with ${PACKAGE_NAME} at ${releaseSpecifier(request.version)} as a devDependency and scripts.operator set to ${PROJECT_SCRIPT}. Commit the installation and dispatch from that commit.`;
  }

  if (request.lockName !== "bun.lock") {
    return "The JSR worktree needs a committed bun.lock from Bun 1.4 or later. Commit the installation and dispatch from that commit.";
  }
  const lockFile = Bun.file(`${request.worktreeRoot}/${request.lockName}`);
  if (!(await lockFile.exists())) {
    return "The worktree base commit has no bun.lock. Commit the installation and dispatch from that commit.";
  }
  const lockBytes = new Uint8Array(await lockFile.arrayBuffer());
  if (!Bun.deepEquals(lockBytes, request.lockBytes)) {
    return "The worktree bun.lock differs from the selected installation. Commit the matching manifest and lock, then dispatch from that commit.";
  }
  return lockMatches(manifest.data, lockBytes, request.version);
}
