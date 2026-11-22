// Bun has no atomic rename API.
import { rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MutationResult } from "./mutation-run.ts";

const point = z.object({ line: z.number(), column: z.number() });
const completed = z.object({
  version: z.literal(1),
  identity: z.string(),
  digest: z.string(),
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["Killed", "Survived", "Ignored", "NoCoverage"]),
      mutatorName: z.string(),
      location: z.object({ start: point, end: point }),
      replacement: z.string(),
      statusReason: z.string().optional(),
    }),
  ),
});

function digest(results: MutationResult[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(results)).digest("hex");
}

export async function readMutationReuse(
  root: string,
  identity: string | undefined,
): Promise<MutationResult[] | undefined> {
  try {
    const record = completed.parse(
      await Bun.file(path.join(root, ".mutation-reuse", `${identity}.json`)).json(),
    );
    if (record.identity !== identity || record.digest !== digest(record.results)) return undefined;
    return record.results;
  } catch {
    // Invalid or interrupted persistence is not reusable evidence.
  }
}

export async function saveMutationReuse(
  root: string,
  identity: string | undefined,
  results: MutationResult[],
): Promise<void> {
  const record = completed.safeParse({ version: 1, identity, results, digest: digest(results) });
  if (!record.success) return;
  record.data.digest = digest(record.data.results);
  const file = path.join(root, ".mutation-reuse", `${identity}.json`);
  await Bun.write(`${file}.tmp`, JSON.stringify(record.data));
  await rename(`${file}.tmp`, file);
}
