import { z } from "zod";

export const JOURNAL_NAME = "publication.json";

const pathRecord = z.strictObject({
  state: z.enum(["published", "failed", "uncertain"]),
  detail: z.string(),
  reference: z.string().nullable(),
  at: z.string(),
});

/**
 * What one release has already delivered.
 * A retry reads this, so a path that succeeded is never sent again and the artifact the first
 * attempt delivered is the one the missing path receives.
 */
export const journalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseId: z.string(),
  version: z.string(),
  commit: z.string(),
  artifactIdentity: z.string(),
  paths: z.partialRecord(z.enum(["github-source", "jsr"]), pathRecord),
});

export type PublicationJournal = z.infer<typeof journalSchema>;
export type PathRecord = z.infer<typeof pathRecord>;

export type JournalRead =
  | { state: "missing" }
  | { state: "unreadable"; detail: string }
  | { state: "read"; journal: PublicationJournal };

export async function readJournal(path: string): Promise<JournalRead> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { state: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    return { state: "unreadable", detail: String(error) };
  }

  const result = journalSchema.safeParse(parsed);
  return result.success
    ? { state: "read", journal: result.data }
    : {
        state: "unreadable",
        detail: result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
}

export async function writeJournal(path: string, journal: PublicationJournal): Promise<void> {
  await Bun.write(path, `${JSON.stringify(journal, null, 2)}\n`, { createPath: true });
}
