// Bun has no atomic rename API.
import { rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MutationResult } from "./mutation-run.ts";
import type { MutationIdentity } from "./mutation-dependencies.ts";

export const mutationReuseSchema = z.discriminatedUnion("eligible", [
  z.object({
    eligible: z.literal(false),
    reason: z.enum(["unsupported-test-command", "uncertain-inputs", "unreadable-inputs"]),
    lookup: z.literal("not-checked"),
  }),
  z.object({
    eligible: z.literal(true),
    identity: z.string(),
    lookup: z.enum(["hit", "miss", "inputs-changed", "unusable"]),
  }),
]);

export type MutationReuse = z.infer<typeof mutationReuseSchema>;

export type MutationReuseLookup =
  | { status: "hit"; results: MutationResult[] }
  | { status: "miss" | "inputs-changed" | "unusable" };

export async function mutationReuseDecision(
  root: string,
  identity: MutationIdentity,
  previousIdentity?: string,
) {
  if (!identity.eligible)
    return { decision: { ...identity, lookup: "not-checked" } satisfies MutationReuse };
  if (previousIdentity !== undefined && previousIdentity !== identity.identity)
    return {
      decision: { ...identity, lookup: "inputs-changed" } satisfies MutationReuse,
      results: undefined,
    };
  const cached = await readMutationReuse(root, identity.identity);
  return {
    decision: { ...identity, lookup: cached.status } satisfies MutationReuse,
    results: cached.status === "hit" ? cached.results : undefined,
  };
}

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
  identity: string,
): Promise<MutationReuseLookup> {
  try {
    const record = completed.parse(
      await Bun.file(path.join(root, ".mutation-reuse", `${identity}.json`)).json(),
    );
    if (record.identity !== identity) return { status: "inputs-changed" };
    if (record.digest !== digest(record.results)) return { status: "unusable" };
    return { status: "hit", results: record.results };
  } catch (error) {
    // Invalid or interrupted persistence is not reusable evidence.
    return {
      status: z.object({ code: z.literal("ENOENT") }).safeParse(error).success
        ? "miss"
        : "unusable",
    };
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
