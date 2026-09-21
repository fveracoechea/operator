import { z } from "zod";

// The launch inputs a dispatch needs from a recorded snapshot. Unknown keys are kept, because the
// record belongs to the release that wrote it and a recovery must not narrow it.
const snapshotSchema = z.looseObject({
  selection: z.looseObject({
    crew: z.looseObject({
      host: z.string().nullable(),
      model: z.string().nullable(),
    }),
  }),
  release: z.looseObject({ version: z.string(), identity: z.string() }),
  lock: z.looseObject({
    name: z.string().nullable(),
    state: z.string(),
    identity: z.string().nullable(),
    path: z.string().nullable(),
  }),
  skills: z.looseObject({ identity: z.string() }),
});

export type RecordedSnapshot = z.infer<typeof snapshotSchema>;

export type SnapshotRead =
  | { status: "read"; snapshot: RecordedSnapshot }
  | { status: "unreadable"; detail: string };

/** Reads one recorded snapshot. A record this release cannot read never launches anything. */
export function readSnapshot(recorded: string): SnapshotRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recorded);
  } catch (error) {
    return { status: "unreadable", detail: String(error) };
  }

  const result = snapshotSchema.safeParse(parsed);
  return result.success
    ? { status: "read", snapshot: result.data }
    : {
        status: "unreadable",
        detail: result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
}
