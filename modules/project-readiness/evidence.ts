import { z } from "zod";

export const EVIDENCE_PATH = ".operator/local/readiness.json";

const probeIdentity = z.string().regex(/^[0-9a-f]{64}$/);

/** Where one recorded resource stood when the run ended. A retained resource still exists. */
const cleanupSchema = z.strictObject({
  state: z.enum(["removed", "retained", "failed", "not-applicable"]),
  detail: z.string(),
});

/**
 * One durable observation of one live check.
 * It records what the check ran against, what it produced, and what it left behind, so a later
 * reader answers from the record rather than from the machine it happens to be on.
 */
const observationSchema = z.strictObject({
  name: z.string(),
  // A skipped check was attempted and could not run. It proves nothing, exactly like a failure.
  state: z.enum(["passed", "failed", "skipped"]),
  detail: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  // The fingerprints this result was proven against. A changed input makes it stale.
  inputs: z.record(z.string(), z.string()),
  // The versions of everything the check ran through, named one by one.
  versions: z.record(z.string(), z.string()),
  outputs: z.array(z.string()),
  evidence: z.array(
    z.strictObject({
      label: z.string(),
      path: z.string().nullable(),
      identity: z.string().nullable(),
    }),
  ),
  cleanup: cleanupSchema,
});

export type Observation = z.infer<typeof observationSchema>;

/** One probe attempt. Attempts are appended and never rewritten, so a failed one is preserved. */
const runSchema = z.strictObject({
  probeId: probeIdentity,
  planRevision: z.number().int().min(1),
  // The approval this run acted under. A record with no approval has no provenance.
  approvedProbeId: probeIdentity,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  targets: z.array(z.string()),
  versions: z.record(z.string(), z.string()),
  observations: z.array(observationSchema),
  cleanup: cleanupSchema.extend({ resources: z.array(z.string()) }),
});

export type Run = z.infer<typeof runSchema>;

const evidenceSchema = z.strictObject({
  schemaVersion: z.literal(2),
  runs: z.array(runSchema),
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

/**
 * The observation that stands for each check: the most recent attempt that ran it.
 * A run that never attempted a check leaves the earlier observation of it standing, so one
 * narrow rerun does not discard evidence it said nothing about.
 */
export function standingObservations(
  evidence: Evidence,
): Map<string, { observation: Observation; run: Run }> {
  const standing = new Map<string, { observation: Observation; run: Run }>();
  for (const run of evidence.runs) {
    for (const observation of run.observations) {
      standing.set(observation.name, { observation, run });
    }
  }

  return standing;
}

/** Appends one attempt. The file holds every attempt, so a failed one survives the next run. */
export async function appendRun(projectRoot: string, run: Run): Promise<Evidence> {
  const read = await readEvidence(projectRoot);
  if (read.state === "unreadable") {
    throw new Error(`the recorded readiness evidence cannot be read: ${read.detail}`);
  }

  const evidence: Evidence = {
    schemaVersion: 2,
    runs: [...(read.state === "read" ? read.evidence.runs : []), run],
  };
  await Bun.write(`${projectRoot}/${EVIDENCE_PATH}`, `${JSON.stringify(evidence, null, 2)}\n`, {
    createPath: true,
  });
  return evidence;
}
