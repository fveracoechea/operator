// Bun has no path manipulation API.
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";
import type { CrewReader } from "./database.ts";
import { assignments } from "./schema.ts";

/** The copies of requirement sources. They stay with the crew state and never enter a worktree. */
const SOURCE_STORE = ".operator/local/sources";

const text = z.string().min(1);

/**
 * Where the words of a requirement come from. A file from any readable path is copied, and a
 * text the crew state already holds needs no copy.
 */
export const requirementSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("copy"), path: text }),
  z.strictObject({ kind: z.literal("approved-scope"), assignmentId: text }),
]);

export type RequirementSource = z.infer<typeof requirementSourceSchema>;

/** How a quote was checked. A requirement that an earlier release recorded is unchecked. */
export const SOURCE_KINDS = ["copy", "approved-scope", "unchecked"] as const;

/** The source of one recorded requirement, as a later session reads it back. */
export type RecordedSource = {
  kind: (typeof SOURCE_KINDS)[number];
  id: string;
  revision: string;
  storedPath: string | null;
};

/** A source made ready to check. A copy is stored before the transaction that records it. */
export type PreparedSource =
  | { kind: "copy"; id: string; revision: string; text: string }
  | { kind: "approved-scope"; assignmentId: string };

export type PrepareOutcome =
  | { status: "prepared"; source: PreparedSource }
  | { status: "source-unreadable"; path: string }
  | { status: "source-not-text"; path: string };

export type QuoteOutcome =
  | { status: "quoted"; source: RecordedSource }
  | { status: "quote-not-in-source"; source: RecordedSource }
  | { status: "unknown-assignment"; assignmentId: string };

/** The CRLF rule of ADR 0019, so a source saved with Windows line ends still matches. */
function normalized(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

export function storedPathOf(revision: string): string {
  return `${SOURCE_STORE}/${revision}`;
}

/**
 * Copies a file source into the crew state store under its content identity.
 * The copy fixes what the quote was checked against, so a later edit of the file, or a file
 * outside the checkout, never makes the record false.
 */
export async function prepareSource(request: {
  projectRoot: string;
  source: RequirementSource;
}): Promise<PrepareOutcome> {
  if (request.source.kind === "approved-scope") {
    return { status: "prepared", source: request.source };
  }

  const id = resolve(request.source.path);
  const bytes = await Bun.file(id)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer))
    .catch(() => null);
  if (bytes === null) {
    return { status: "source-unreadable", path: id };
  }

  // A lenient decode drops a byte order mark and replaces invalid bytes, so a quote could match
  // bytes that are not in the copy. Only exact UTF-8 text is compared.
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { status: "source-not-text", path: id };
  }

  const revision = ContentIdentity.ofBytes(bytes);
  await Bun.write(`${request.projectRoot}/${storedPathOf(revision)}`, bytes, { createPath: true });
  return { status: "prepared", source: { kind: "copy", id, revision, text: decoded } };
}

/** Checks that the exact words appear in the source, byte for byte after the CRLF rule. */
export function quoteSource(
  db: CrewReader,
  request: { source: PreparedSource; exactText: string },
): QuoteOutcome {
  const held =
    request.source.kind === "copy"
      ? {
          text: request.source.text,
          source: {
            kind: "copy" as const,
            id: request.source.id,
            revision: request.source.revision,
            storedPath: storedPathOf(request.source.revision),
          },
        }
      : heldText(db, request.source.assignmentId);
  if ("status" in held) {
    return held;
  }

  return normalized(held.text).includes(normalized(request.exactText))
    ? { status: "quoted", source: held.source }
    : { status: "quote-not-in-source", source: held.source };
}

function heldText(
  db: CrewReader,
  assignmentId: string,
):
  | { text: string; source: RecordedSource }
  | { status: "unknown-assignment"; assignmentId: string } {
  const row = db
    .select({ approvedScope: assignments.approvedScope })
    .from(assignments)
    .where(eq(assignments.id, assignmentId))
    .all()[0];
  if (row === undefined) {
    return { status: "unknown-assignment", assignmentId };
  }

  return {
    text: row.approvedScope,
    source: {
      kind: "approved-scope",
      id: assignmentId,
      revision: ContentIdentity.ofText(row.approvedScope),
      storedPath: null,
    },
  };
}
