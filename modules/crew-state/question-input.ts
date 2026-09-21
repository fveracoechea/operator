import { z } from "zod";

/**
 * The five subjects an Operator may never settle on its own.
 * A question that names one of them is answered by a person or by an approved requirement,
 * never by an Operator decision.
 */
export const ESCALATION_TRIGGERS = [
  "visible-behavior",
  "scope",
  "security-permissions",
  "ambiguity",
  "conflicting-requirements",
] as const;

const text = z.string().min(1);

/**
 * One blocked report. The object is strict, so an Operative report that carries an approval,
 * an authority, or any other field cannot widen what the Operator may do with it.
 */
export const questionInputSchema = z.strictObject({
  question: text,
  evidence: z.array(z.strictObject({ label: text, detail: text })).min(1),
  options: z.array(z.strictObject({ name: text, detail: text, risk: text })).min(1),
  recommendation: text,
  affectedScope: z.array(text).min(1),
  independentWork: z.array(text),
  escalationTriggers: z.array(z.enum(ESCALATION_TRIGGERS)),
});

export type QuestionInput = z.infer<typeof questionInputSchema>;

const interpretation = z.strictObject({
  summary: text,
  directives: z.array(text).min(1),
  appliesTo: z.array(text).min(1),
});

const source = z.strictObject({ id: text, revision: text });

/**
 * One answer. Each authority carries its own evidence rule, so the three are never confused:
 * a requirement quotes an approved source, a human answer quotes the person, and an Operator
 * decision quotes nobody because there is no human text behind it.
 */
export const answerInputSchema = z.discriminatedUnion("authority", [
  z.strictObject({
    authority: z.literal("requirement"),
    exactText: text,
    source,
    interpretation,
  }),
  z.strictObject({
    authority: z.literal("human-answer"),
    exactText: text,
    interpretation,
  }),
  z.strictObject({
    authority: z.literal("operator-decision"),
    interpretation,
  }),
]);

export type AnswerInput = z.infer<typeof answerInputSchema>;

/**
 * One approval. `grantedBy` is a literal because a person is the only source of authority:
 * silence, a timeout, a general direction to finish, and an Operative report produce nothing.
 */
export const approvalInputSchema = z.strictObject({
  action: text,
  targets: z.array(text).min(1),
  scope: text,
  requestRevision: text,
  exactText: text,
  grantedBy: z.literal("human"),
});

export type ApprovalInput = z.infer<typeof approvalInputSchema>;

/** One approval question: does a recorded approval cover this exact action right now? */
export const approvalCheckSchema = z.strictObject({
  action: text,
  targets: z.array(text).min(1),
  scope: text,
  requestRevision: text,
});

export type ApprovalCheck = z.infer<typeof approvalCheckSchema>;
