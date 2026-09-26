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

export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/**
 * The two subjects no recorded source can close.
 * A conflict means no single source settles the question, so quoting one of them decides it by
 * choosing a side. An ambiguity means clarity could not be established at all.
 * The other three are answered by an approved source that states them, or by the user.
 */
export const HUMAN_ONLY_TRIGGERS = [
  "ambiguity",
  "conflicting-requirements",
] as const satisfies EscalationTrigger[];

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

/**
 * The Operator's own finding that one question names a subject only a person may settle.
 * The Operative declares what it sees; this records what the Operator sees, so the refusal of
 * an Operator decision survives the session that found the reason for it.
 */
export const escalationInputSchema = z.strictObject({
  escalationTriggers: z.array(z.enum(ESCALATION_TRIGGERS)).min(1),
  reason: text,
});

export type EscalationInput = z.infer<typeof escalationInputSchema>;

export const answerInterpretationSchema = z.strictObject({
  summary: text,
  directives: z.array(text).min(1),
  appliesTo: z.array(text).min(1),
});

export type AnswerInterpretation = z.infer<typeof answerInterpretationSchema>;

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
    interpretation: answerInterpretationSchema,
  }),
  z.strictObject({
    authority: z.literal("human-answer"),
    exactText: text,
    interpretation: answerInterpretationSchema,
  }),
  z.strictObject({
    authority: z.literal("operator-decision"),
    interpretation: answerInterpretationSchema,
  }),
]);

export type AnswerInput = z.infer<typeof answerInputSchema>;
