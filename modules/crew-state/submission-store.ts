// Bun has no path manipulation API.
import { basename } from "node:path";
import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { BriefRecord } from "./planning-record.ts";
import { readStored } from "./stored.ts";
import type { SubmittedArtifact } from "./submission-input.ts";
import type { AssignmentRow } from "./assignment.ts";
import { identityOf } from "./identity.ts";
import { storedFixedInputs, storedRequirements } from "./work-input.ts";
import { readVerified } from "./verified-copy.ts";

export const SUBMISSION_STORE = ".operator/local/submissions";

/** One artifact as the review reads it: a value, or a durable copy outside the worktree. */
export const storedArtifactSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["value", "path"]),
  value: z.string(),
  contentIdentity: z.string(),
  storedPath: z.string().nullable(),
});

export type StoredArtifact = z.infer<typeof storedArtifactSchema>;

export function storedArtifacts(stored: string): StoredArtifact[] {
  return readStored("artifact list", z.array(storedArtifactSchema), stored);
}

export type StoreOutcome =
  | { status: "stored"; artifacts: StoredArtifact[] }
  | { status: "artifact-unreadable"; name: string; path: string }
  | { status: "artifact-identity-changed"; name: string; path: string; found: string };

/** The rules the artifact store refuses, each with the refusal name the CLI reports for it. */
export const ARTIFACT_RULES = [
  {
    refusal: "artifact_unreadable",
    rule: "Each path artifact is a file at its stated path in this worktree.",
  },
  {
    refusal: "artifact_identity_changed",
    rule: "Each path artifact states the content identity of that file.",
  },
];

function fileName(index: number, artifact: SubmittedArtifact): string {
  const clean = basename(artifact.value).replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return `${index}-${clean.length === 0 ? "artifact" : clean}`;
}

/** One file copied into the store, with the identity a later reader verifies it against. */
export type StoredCopy = { storedPath: string; contentIdentity: string };

/** Where the spec copy of one submission lives. Artifact copies carry an index, so none collides. */
export function specPathOf(submissionId: string): string {
  return `${SUBMISSION_STORE}/${submissionId}/spec.md`;
}

/**
 * Copies the work one result was produced against into the store, as the spec its review reads.
 * The reviewer has no network and the issue can change after registration, so the review reads
 * this fixed copy, bound by the requirements identity that the submission records (ADR 0007).
 * It also holds the planning records that the producer brief carried, in the same rendering, so
 * the Spec axis checks the result against the decisions that it followed (ADR 0019).
 */
export async function storeSpec(request: {
  projectRoot: string;
  submissionId: string;
  assignment: AssignmentRow;
  planningRecords: BriefRecord[];
}): Promise<StoredCopy> {
  const { assignment } = request;
  const requirements = storedRequirements(assignment.acceptanceRequirements);
  const fixedInputs = storedFixedInputs(assignment.fixedInputs);
  const text = [
    `# Spec of assignment ${assignment.id}`,
    "",
    assignment.title,
    "",
    "## Approved scope",
    "",
    assignment.approvedScope,
    "",
    "## Acceptance requirements",
    "",
    ...requirements.map((one) => `- ${one}`),
    "",
    `Requirements identity: ${identityOf(requirements)}`,
    "",
    "## Fixed inputs",
    "",
    ...(fixedInputs.length === 0
      ? ["This assignment fixes no inputs."]
      : fixedInputs.map(
          (one) =>
            `- ${one.name} (${one.kind}): ${one.value}${
              one.contentIdentity === null ? "" : ` [${one.contentIdentity}]`
            }`,
        )),
    "",
    ...OperativeDispatch.planningRecordsSection({ inputs: request.planningRecords }),
  ].join("\n");

  const storedPath = specPathOf(request.submissionId);
  await Bun.write(`${request.projectRoot}/${storedPath}`, text, { createPath: true });
  return { storedPath, contentIdentity: ContentIdentity.ofText(text) };
}

/**
 * Copies every path artifact out of the Operative worktree and verifies its stated identity.
 * The review reads these copies, so a later edit in that worktree cannot change the evidence
 * a report was written against.
 */
export async function storeArtifacts(request: {
  projectRoot: string;
  worktreePath: string;
  submissionId: string;
  artifacts: SubmittedArtifact[];
}): Promise<StoreOutcome> {
  const stored: StoredArtifact[] = [];

  for (const [index, artifact] of request.artifacts.entries()) {
    if (artifact.kind === "value" || artifact.contentIdentity === null) {
      stored.push({
        name: artifact.name,
        kind: artifact.kind,
        value: artifact.value,
        contentIdentity: ContentIdentity.ofText(artifact.value),
        storedPath: null,
      });
      continue;
    }

    const read = await readVerified(
      `${request.worktreePath}/${artifact.value}`,
      artifact.contentIdentity,
    );
    if (read.status === "unreadable") {
      return { status: "artifact-unreadable", name: artifact.name, path: artifact.value };
    }
    if (read.status === "identity-changed") {
      return {
        status: "artifact-identity-changed",
        name: artifact.name,
        path: artifact.value,
        found: read.found,
      };
    }
    const { bytes } = read;
    const found = artifact.contentIdentity;

    const storedPath = `${SUBMISSION_STORE}/${request.submissionId}/${fileName(index, artifact)}`;
    await Bun.write(`${request.projectRoot}/${storedPath}`, bytes, { createPath: true });
    stored.push({
      name: artifact.name,
      kind: artifact.kind,
      value: artifact.value,
      contentIdentity: found,
      storedPath,
    });
  }

  return { status: "stored", artifacts: stored };
}
