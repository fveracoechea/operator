// Bun has no path manipulation API.
import { basename } from "node:path";

// These follow the submission contract in crew-state. A launch cannot import that module,
// because crew-state is what calls this one, so the shapes are restated rather than widened.
// A reviewer and a rework Operative read the same fixed result, so both read it from here.

export type FixedArtifact = {
  name: string;
  kind: "value" | "path";
  value: string;
  contentIdentity: string;
  storedPath: string | null;
};

export type FixedCheck = {
  name: string;
  command: string;
  outcome: "passed" | "failed" | "flaky" | "not-run";
  detail: string;
};

export type FixedCode = {
  baseCommit: string;
  resultCommit: string;
  mergeBase: string;
  branch: string;
};

/** Where one copied artifact lands inside the worktree that reads it. */
export function copiedInputPath(directory: string, artifact: FixedArtifact): string | null {
  return artifact.storedPath === null ? null : `${directory}/${basename(artifact.storedPath)}`;
}

/** One fixed copy that a launch carries from the controlling checkout into the worktree. */
export type FixedCopy = { path: string; sourcePath: string; identity: string };

/**
 * The fixed copies one role reads. The launch copies the submitted artifacts before the planning
 * copies and the other fixed texts after them, and the first copy that fails names the failure.
 */
export type RoleCopies = { artifacts: FixedCopy[]; texts: FixedCopy[] };

/** The copy of one stored text, read from the controlling checkout. */
export function storedCopy(
  path: string,
  stored: { storedPath: string; contentIdentity: string },
  projectRoot: string,
): FixedCopy {
  return {
    path,
    sourcePath: `${projectRoot}/${stored.storedPath}`,
    identity: stored.contentIdentity,
  };
}

/** The copies of the submitted artifacts that have a stored file. A value artifact has none. */
export function artifactCopies(
  directory: string,
  artifacts: FixedArtifact[],
  projectRoot: string,
): FixedCopy[] {
  return artifacts.flatMap((artifact) => {
    const path = copiedInputPath(directory, artifact);
    return artifact.storedPath === null || path === null
      ? []
      : [
          storedCopy(
            path,
            { storedPath: artifact.storedPath, contentIdentity: artifact.contentIdentity },
            projectRoot,
          ),
        ];
  });
}
