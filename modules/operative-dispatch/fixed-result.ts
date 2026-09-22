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

export type FixedPullRequest =
  | { status: "open"; number: number; headCommit: string }
  | { status: "authority-missing"; detail: string };

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
  pullRequest: FixedPullRequest;
};

/** Where one copied artifact lands inside the worktree that reads it. */
export function copiedInputPath(directory: string, artifact: FixedArtifact): string | null {
  return artifact.storedPath === null ? null : `${directory}/${basename(artifact.storedPath)}`;
}

export function pullRequestLine(pull: FixedPullRequest): string {
  return pull.status === "open"
    ? `- Pull request: #${pull.number} at head ${pull.headCommit}`
    : `- Pull request: not created (${pull.detail})`;
}
