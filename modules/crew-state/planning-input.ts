import { z } from "zod";
import { answerInterpretationSchema, ESCALATION_TRIGGERS } from "./question-input.ts";
import { requirementSourceSchema, SOURCE_KINDS } from "./requirement-source.ts";

const text = z.string().min(1);

const contentIdentity = z.string().regex(/^[0-9a-f]{64}$/, {
  error: "a content identity is a SHA256 digest in lower-case hexadecimal",
});

/**
 * The fields every decision entry holds. The question stays beside the words, because a short
 * answer has a meaning only next to the question it answers. The subjects are what the question
 * names, so a requirement cannot settle an ambiguity or a conflict among the sources.
 */
const entryFields = {
  question: text,
  escalationTriggers: z.array(z.enum(ESCALATION_TRIGGERS)),
  interpretation: answerInterpretationSchema,
};

/** One decision of a planning record, in the authority shape of an answer of ADR 0006. */
export const planningEntrySchema = z.discriminatedUnion("authority", [
  z.strictObject({
    ...entryFields,
    authority: z.literal("requirement"),
    exactText: text,
    source: requirementSourceSchema,
  }),
  z.strictObject({ ...entryFields, authority: z.literal("human-answer"), exactText: text }),
  z.strictObject({ ...entryFields, authority: z.literal("operator-decision") }),
]);

export type PlanningEntryInput = z.infer<typeof planningEntrySchema>;

/** A longer text of the record. Operator stores a copy and checks it by its content identity. */
const artifactInput = z.strictObject({ name: text, path: text, contentIdentity });

/**
 * The planning record that one planning acceptance records.
 * A planning item that turns out not to be needed still records one entry that says so, so an
 * acceptance never unblocks a dependent that then receives nothing.
 */
export const planningRecordInputSchema = z.strictObject({
  entries: z.array(planningEntrySchema).min(1),
  artifacts: z.array(artifactInput),
});

export type PlanningRecordInput = z.infer<typeof planningRecordInputSchema>;

const recordedSource = z.strictObject({
  kind: z.enum(SOURCE_KINDS),
  id: z.string(),
  revision: z.string(),
  storedPath: z.string().nullable(),
});

/** One decision as the crew state holds it, with the source its quote was checked against. */
export const storedEntrySchema = z.strictObject({
  question: z.string(),
  escalationTriggers: z.array(z.enum(ESCALATION_TRIGGERS)),
  authority: z.enum(["requirement", "human-answer", "operator-decision"]),
  exactText: z.string().nullable(),
  source: recordedSource.nullable(),
  interpretation: answerInterpretationSchema,
});

export type StoredEntry = z.infer<typeof storedEntrySchema>;

/** One artifact as the crew state holds it. Its bytes stay in the planning store. */
export const storedPlanningArtifactSchema = z.strictObject({
  name: z.string(),
  contentIdentity: z.string(),
  storedPath: z.string(),
  // Only a text artifact is rendered into the tracker resolution.
  text: z.boolean(),
});

export type StoredPlanningArtifact = z.infer<typeof storedPlanningArtifactSchema>;
