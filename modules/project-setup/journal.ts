import { z } from "zod";

export const JOURNAL_PATH = ".operator/local/setup-journal.json";

const journalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: z.string(),
  status: z.enum(["in-progress", "complete", "rolled-back"]),
  writes: z.array(
    z.strictObject({
      path: z.string(),
      existedBefore: z.boolean(),
      previousText: z.string().nullable(),
      previousSha: z.string().nullable(),
      writtenSha: z.string(),
    }),
  ),
});

export type Journal = z.infer<typeof journalSchema>;

export type JournalRead =
  | { state: "missing" }
  | { state: "unreadable"; detail: string }
  | { state: "read"; journal: Journal };

export async function readJournal(projectRoot: string): Promise<JournalRead> {
  const file = Bun.file(`${projectRoot}/${JOURNAL_PATH}`);
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
  if (!result.success) {
    return {
      state: "unreadable",
      detail: result.error.issues.map((issue) => issue.message).join("; "),
    };
  }

  return { state: "read", journal: result.data };
}

export async function writeJournal(projectRoot: string, journal: Journal): Promise<void> {
  await Bun.write(`${projectRoot}/${JOURNAL_PATH}`, `${JSON.stringify(journal, null, 2)}\n`, {
    createPath: true,
  });
}
