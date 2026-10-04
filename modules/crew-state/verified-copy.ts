import { ContentIdentity } from "../content-identity/main.ts";

export type VerifiedRead =
  | { status: "read"; bytes: Uint8Array }
  | { status: "unreadable" }
  | { status: "identity-changed"; found: string };

/**
 * Reads one file that must hold the content identity it was named with.
 * A submission artifact, a planning artifact, and a stored copy read back for the tracker all
 * pass this one check, so a changed file never stands in for the text that was recorded.
 */
export async function readVerified(path: string, contentIdentity: string): Promise<VerifiedRead> {
  const bytes = await Bun.file(path)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer))
    .catch(() => null);
  if (bytes === null) {
    return { status: "unreadable" };
  }

  const found = ContentIdentity.ofBytes(bytes);
  return found === contentIdentity
    ? { status: "read", bytes }
    : { status: "identity-changed", found };
}
