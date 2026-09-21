import { z } from "zod";

export const EVIDENCE_PATH = ".operator/local/readiness.json";

const evidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checks: z.array(
    z.strictObject({
      name: z.string(),
      state: z.enum(["passed", "failed"]),
      // The approved probe that produced this result. A record with no probe has no provenance.
      probeId: z.string().regex(/^[0-9a-f]{64}$/),
      observedAt: z.iso.datetime(),
      detail: z.string(),
      // The fingerprints this result was proven against. A changed input makes it stale.
      inputs: z.record(z.string(), z.string()),
    }),
  ),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export type EvidenceRead =
  | { state: "missing" }
  | { state: "unreadable"; detail: string }
  | { state: "read"; evidence: Evidence };

export async function readEvidence(projectRoot: string): Promise<EvidenceRead> {
  const file = Bun.file(`${projectRoot}/${EVIDENCE_PATH}`);
  if (!(await file.exists())) {
    return { state: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    return { state: "unreadable", detail: String(error) };
  }

  const result = evidenceSchema.safeParse(parsed);
  if (!result.success) {
    return {
      state: "unreadable",
      detail: result.error.issues
        .map((issue) => [issue.path.join("."), issue.message].filter(Boolean).join(": "))
        .join("; "),
    };
  }

  return { state: "read", evidence: result.data };
}
