// Bun has no path API.
import path from "node:path";
import { z } from "zod";

const line = z.string().trim().min(1).max(2000);

/** The worker's submission. Each answer names who gave it, and acceptance never changes that. */
export const submissionSchema = z
  .strictObject({
    conclusion: z.string().trim().min(1).max(4000),
    evidence: z.array(line).min(1),
    unresolved: z.array(line),
    decisions: z
      .array(
        z.strictObject({
          question: line,
          answer: line,
          by: z.enum(["person", "super-agent"]),
        }),
      )
      .default([]),
    files: z
      .array(z.string().refine((file) => path.isAbsolute(file), "Use absolute file paths."))
      .default([]),
  })
  .superRefine((submission, context) => {
    const names = submission.files.map((file) => path.basename(file));
    if (new Set(names).size !== names.length)
      context.addIssue({ code: "custom", message: "Supporting file names must be unique." });
  });
export type Submission = z.infer<typeof submissionSchema>;

function list(items: string[]) {
  return items.length === 0 ? "- None." : items.map((item) => `- ${item}`).join("\n");
}

function answers(submission: Submission, by: "person" | "super-agent") {
  return list(
    submission.decisions
      .filter((decision) => decision.by === by)
      .map((decision) => `${decision.question} Answer: ${decision.answer}`),
  );
}

/** The durable report file. Human answers and SuperAgent decisions stay in separate sections. */
export function renderReport(input: {
  number: number;
  assignment: string;
  submission: Submission;
  files: string[];
}) {
  const { submission } = input;
  return `# Report ${input.number} for ${input.assignment}

## Conclusion

${submission.conclusion}

## Evidence

${list(submission.evidence)}

## Unresolved points

${list(submission.unresolved)}

## Human answers

${answers(submission, "person")}

## SuperAgent decisions

A SuperAgent decision is not a human answer.

${answers(submission, "super-agent")}

## Supporting files

${list(input.files.map((file) => `\`${file}\``))}
`;
}
