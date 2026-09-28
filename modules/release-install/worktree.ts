import { z } from "zod";
import { JSR_PACKAGE_NAME, PACKAGE_NAME, PROJECT_SCRIPT } from "./selection.ts";

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

/** A frozen install must read the same manifest and lock at the launch base commit. */
export async function checkWorktreeInstallation(request: {
  worktreeRoot: string;
  version: string;
  lockName: string;
  lockBytes: Uint8Array;
}): Promise<string | null> {
  const manifestFile = Bun.file(`${request.worktreeRoot}/package.json`);
  const manifest = manifestSchema.safeParse(await manifestFile.json().catch(() => null));
  const expected = `npm:${JSR_PACKAGE_NAME}@${request.version}`;
  if (
    !manifest.success ||
    manifest.data.devDependencies?.[PACKAGE_NAME] !== expected ||
    manifest.data.scripts.operator !== PROJECT_SCRIPT
  ) {
    return `The worktree base commit needs package.json with ${PACKAGE_NAME} at ${expected} as a devDependency and scripts.operator set to ${PROJECT_SCRIPT}. Commit the installation and dispatch from that commit.`;
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

  let lockData: unknown;
  try {
    lockData = Bun.JSONC.parse(new TextDecoder().decode(lockBytes));
  } catch {
    return "The worktree bun.lock cannot be read. Regenerate it with Bun, commit it, and dispatch from that commit.";
  }
  const locked = lockSchema.safeParse(lockData);
  if (!locked.success)
    return "The worktree bun.lock cannot be read. Regenerate it with Bun, commit it, and dispatch from that commit.";
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const declared = manifest.data[key] ?? {};
    const recorded = locked.data.workspaces[""][key] ?? {};
    if (!Bun.deepEquals(declared, recorded)) {
      return `The worktree package.json ${key} differs from bun.lock. Commit a frozen installation at the base commit before dispatch.`;
    }
  }
  if (locked.data.packages[PACKAGE_NAME]?.[0] !== `${JSR_PACKAGE_NAME}@${request.version}`) {
    return `The worktree bun.lock does not pin ${PACKAGE_NAME} at ${request.version}. Commit the selected JSR dependency before dispatch.`;
  }
  return null;
}
