// Bun has no path manipulation API.
import { basename } from "node:path";
import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";
import { readStored } from "./stored.ts";
import type { SubmittedArtifact } from "./submission-input.ts";

export const SUBMISSION_STORE = ".operator/local/submissions";

/** One artifact as the review reads it: a value, or a durable copy outside the worktree. */
const storedArtifact = z.strictObject({
  name: z.string(),
  kind: z.enum(["value", "path"]),
  value: z.string(),
  contentIdentity: z.string(),
  storedPath: z.string().nullable(),
});

export type StoredArtifact = z.infer<typeof storedArtifact>;

export function storedArtifacts(stored: string): StoredArtifact[] {
  return readStored("artifact list", z.array(storedArtifact), stored);
}

export type StoreOutcome =
  | { status: "stored"; artifacts: StoredArtifact[] }
  | { status: "artifact-unreadable"; name: string; path: string }
  | { status: "artifact-identity-changed"; name: string; path: string; found: string };

function fileName(index: number, artifact: SubmittedArtifact): string {
  const clean = basename(artifact.value).replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return `${index}-${clean.length === 0 ? "artifact" : clean}`;
}

/**
 * Copies every path artifact out of the Operative worktree and verifies its stated identity.
 * The review reads these copies, so a later edit in that worktree cannot change the evidence
 * a report was written against.
 */
export async function storeArtifacts(request: {
  projectRoot: string;
  worktreePath: string;
  submissionId: string;
  artifacts: SubmittedArtifact[];
}): Promise<StoreOutcome> {
  const stored: StoredArtifact[] = [];

  for (const [index, artifact] of request.artifacts.entries()) {
    if (artifact.kind === "value" || artifact.contentIdentity === null) {
      stored.push({
        name: artifact.name,
        kind: artifact.kind,
        value: artifact.value,
        contentIdentity: ContentIdentity.ofText(artifact.value),
        storedPath: null,
      });
      continue;
    }

    const source = `${request.worktreePath}/${artifact.value}`;
    const file = Bun.file(source);
    if (!(await file.exists())) {
      return { status: "artifact-unreadable", name: artifact.name, path: artifact.value };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const found = ContentIdentity.ofBytes(bytes);
    if (found !== artifact.contentIdentity) {
      return {
        status: "artifact-identity-changed",
        name: artifact.name,
        path: artifact.value,
        found,
      };
    }

    const storedPath = `${SUBMISSION_STORE}/${request.submissionId}/${fileName(index, artifact)}`;
    await Bun.write(`${request.projectRoot}/${storedPath}`, bytes, { createPath: true });
    stored.push({
      name: artifact.name,
      kind: artifact.kind,
      value: artifact.value,
      contentIdentity: found,
      storedPath,
    });
  }

  return { status: "stored", artifacts: stored };
}
