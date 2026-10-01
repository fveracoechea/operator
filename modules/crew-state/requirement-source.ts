// Bun has no path manipulation API.
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";
import type { CrewReader } from "./database.ts";
import { assignments, workSources } from "./schema.ts";

/** The copies of requirement sources. They stay with the crew state and never enter a worktree. */
const SOURCE_STORE = ".operator/local/sources";

const text = z.string().min(1);

// A revision names a file in the source store, so it never names a folder or leaves the store.
const storeName = text.refine((value) => !/[/\\]/.test(value) && !value.startsWith("."), {
  message: "A revision is one file name in the source store.",
});

/**
 * Where the words of a requirement come from. A file from any readable path is copied, and a
 * text the crew state already holds needs no copy: the approved scope of a registered item, or
 * the stored copy of the recorded revision of a work source.
 */
export const requirementSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("copy"), path: text }),
  z.strictObject({ kind: z.literal("approved-scope"), assignmentId: text }),
  z.strictObject({ kind: z.literal("source-revision"), sourceId: text, revision: storeName }),
]);

export type RequirementSource = z.infer<typeof requirementSourceSchema>;

/** How a quote was checked. A requirement that an earlier release recorded is unchecked. */
export const SOURCE_KINDS = ["copy", "approved-scope", "source-revision", "unchecked"] as const;

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
  | { kind: "approved-scope"; assignmentId: string }
  | { kind: "source-revision"; sourceId: string; revision: string; text: string };

export type PrepareOutcome =
  | { status: "prepared"; source: PreparedSource }
  | { status: "source-unreadable"; path: string }
  | { status: "source-not-text"; path: string };

export type QuoteOutcome =
  | { status: "quoted"; source: RecordedSource }
  | { status: "quote-not-in-source"; source: RecordedSource }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "source-unknown"; sourceId: string }
  | { status: "source-revision-changed"; sourceId: string; revision: string; recorded: string };

/** The CRLF rule of ADR 0019, so a source saved with Windows line ends still matches. */
function normalized(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

export function storedPathOf(revision: string): string {
  return `${SOURCE_STORE}/${revision}`;
}

/**
 * Reads a file source and fixes its content identity. It writes nothing, so a quote that the
 * copy refuses leaves no copy behind.
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
  if (request.source.kind === "source-revision") {
    return prepareSourceRevision(request.projectRoot, request.source);
  }

  const id = resolve(request.source.path);
  const read = await readText(id);
  if (read.status !== "read") {
    return read;
  }

  return {
    status: "prepared",
    source: { kind: "copy", id, revision: ContentIdentity.ofBytes(read.bytes), text: read.text },
  };
}

async function readText(
  path: string,
): Promise<
  | { status: "read"; bytes: Uint8Array; text: string }
  | { status: "source-unreadable" | "source-not-text"; path: string }
> {
  const bytes = await Bun.file(path)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer))
    .catch(() => null);
  if (bytes === null) {
    return { status: "source-unreadable", path };
  }

  // A lenient decode drops a byte order mark and replaces invalid bytes, so a quote could match
  // bytes that are not in the copy. Only exact UTF-8 text is compared.
  try {
    return {
      status: "read",
      bytes,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return { status: "source-not-text", path };
  }
}

/**
 * Reads the stored copy of one work source revision. The crew state already holds that copy, so
 * nothing new is stored, and a revision with no stored copy cannot be quoted.
 */
async function prepareSourceRevision(
  projectRoot: string,
  source: Extract<RequirementSource, { kind: "source-revision" }>,
): Promise<PrepareOutcome> {
  const storedPath = storedPathOf(source.revision);
  const read = await readText(`${projectRoot}/${storedPath}`);
  return read.status === "read"
    ? { status: "prepared", source: { ...source, text: read.text } }
    : { ...read, path: storedPath };
}

/**
 * The refusal of a quote that a file source does not hold, read before anything is stored.
 * A text the crew state holds is checked inside the transaction that records it.
 */
export function copyRefusal(request: {
  source: PreparedSource;
  exactText: string;
}): Extract<QuoteOutcome, { status: "quote-not-in-source" }> | null {
  const { source } = request;
  if (source.kind === "source-revision") {
    return normalized(source.text).includes(normalized(request.exactText))
      ? null
      : {
          status: "quote-not-in-source",
          source: {
            kind: "source-revision",
            id: source.sourceId,
            revision: source.revision,
            storedPath: storedPathOf(source.revision),
          },
        };
  }
  if (source.kind !== "copy" || normalized(source.text).includes(normalized(request.exactText))) {
    return null;
  }
  return {
    status: "quote-not-in-source",
    // No copy is stored for a refused quote, so the refusal points to the source it read.
    source: { kind: "copy", id: source.id, revision: source.revision, storedPath: null },
  };
}

/**
 * Stores the copy of a file source in the crew state store under its content identity.
 * It runs before the transaction that records the quote, so a record never names a missing copy.
 */
export async function storeSource(request: {
  projectRoot: string;
  source: PreparedSource;
}): Promise<void> {
  if (request.source.kind !== "copy") {
    return;
  }
  await Bun.write(
    `${request.projectRoot}/${storedPathOf(request.source.revision)}`,
    request.source.text,
    { createPath: true },
  );
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
      : request.source.kind === "source-revision"
        ? heldRevision(db, request.source)
        : heldText(db, request.source.assignmentId);
  if ("status" in held) {
    return held;
  }

  return normalized(held.text).includes(normalized(request.exactText))
    ? { status: "quoted", source: held.source }
    : { status: "quote-not-in-source", source: held.source };
}

/**
 * The stored copy of a work source revision, read before the transaction. A quote binds the
 * revision that the crew state records now, so a revision that is not the recorded one refuses.
 */
function heldRevision(
  db: CrewReader,
  source: Extract<PreparedSource, { kind: "source-revision" }>,
):
  | { text: string; source: RecordedSource }
  | Extract<QuoteOutcome, { status: "source-unknown" | "source-revision-changed" }> {
  const row = db
    .select({ revision: workSources.revision })
    .from(workSources)
    .where(eq(workSources.id, source.sourceId))
    .all()[0];
  if (row === undefined) {
    return { status: "source-unknown", sourceId: source.sourceId };
  }
  if (row.revision !== source.revision) {
    return {
      status: "source-revision-changed",
      sourceId: source.sourceId,
      revision: source.revision,
      recorded: row.revision,
    };
  }

  return {
    text: source.text,
    source: {
      kind: "source-revision",
      id: source.sourceId,
      revision: source.revision,
      storedPath: storedPathOf(source.revision),
    },
  };
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
