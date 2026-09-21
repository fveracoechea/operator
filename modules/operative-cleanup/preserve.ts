import { ContentIdentity } from "../content-identity/main.ts";

/** Where preserved evidence lives in the controlling checkout, outside every Operative worktree. */
export const EVIDENCE_STORE = ".operator/local/evidence";

/** One preserved file, named by where it came from and what it holds. */
export type EvidenceItem = {
  name: string;
  origin: "worktree" | "checkout";
  path: string;
  storedPath: string;
  contentIdentity: string;
};

export type PreserveOutcome =
  | { status: "preserved"; items: EvidenceItem[] }
  | { status: "evidence-missing"; name: string; path: string }
  | { status: "evidence-changed"; name: string; path: string; expected: string; found: string };

export type VerifyOutcome =
  | { status: "verified" }
  | { status: "evidence-missing"; name: string; path: string }
  | { status: "evidence-changed"; name: string; path: string; expected: string; found: string };

function safeName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

async function readBytes(path: string): Promise<Uint8Array | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
}

/**
 * Copies the named evidence out of one Operative worktree and verifies every copy.
 * The list is explicit: only files this release wrote or a submission fixed are preserved, so
 * a credential the host keeps in its own store is never archived beside the evidence.
 */
export async function preserveEvidence(request: {
  projectRoot: string;
  worktreePath: string;
  attemptId: string;
  copies: Array<{ name: string; path: string }>;
  held: Array<{ name: string; storedPath: string; contentIdentity: string }>;
}): Promise<PreserveOutcome> {
  const items: EvidenceItem[] = [];

  for (const copy of request.copies) {
    const bytes = await readBytes(`${request.worktreePath}/${copy.path}`);
    if (bytes === null) {
      return { status: "evidence-missing", name: copy.name, path: copy.path };
    }

    const contentIdentity = ContentIdentity.ofBytes(bytes);
    const storedPath = `${EVIDENCE_STORE}/${request.attemptId}/${safeName(copy.name)}`;
    await Bun.write(`${request.projectRoot}/${storedPath}`, bytes, { createPath: true });

    const written = await readBytes(`${request.projectRoot}/${storedPath}`);
    if (written === null || ContentIdentity.ofBytes(written) !== contentIdentity) {
      return {
        status: "evidence-changed",
        name: copy.name,
        path: storedPath,
        expected: contentIdentity,
        found: written === null ? "none" : ContentIdentity.ofBytes(written),
      };
    }

    items.push({
      name: copy.name,
      origin: "worktree",
      path: copy.path,
      storedPath,
      contentIdentity,
    });
  }

  // A submission already copied its artifacts out of the worktree, so those are verified here
  // rather than copied a second time into a second rendering of the same evidence.
  for (const one of request.held) {
    items.push({
      name: one.name,
      origin: "checkout",
      path: one.storedPath,
      storedPath: one.storedPath,
      contentIdentity: one.contentIdentity,
    });
  }

  const verified = await verifyEvidence({ projectRoot: request.projectRoot, items });
  return verified.status === "verified" ? { status: "preserved", items } : verified;
}

/**
 * Reads every preserved copy back before a checkout is removed.
 * Evidence that is gone or changed retains the resource, because deletion is the last moment
 * at which the record can still be repaired from the worktree.
 */
export async function verifyEvidence(request: {
  projectRoot: string;
  items: EvidenceItem[];
}): Promise<VerifyOutcome> {
  for (const item of request.items) {
    const bytes = await readBytes(`${request.projectRoot}/${item.storedPath}`);
    if (bytes === null) {
      return { status: "evidence-missing", name: item.name, path: item.storedPath };
    }

    const found = ContentIdentity.ofBytes(bytes);
    if (found !== item.contentIdentity) {
      return {
        status: "evidence-changed",
        name: item.name,
        path: item.storedPath,
        expected: item.contentIdentity,
        found,
      };
    }
  }

  return { status: "verified" };
}
