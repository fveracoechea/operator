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

const headings = new Set([
  "Conclusion",
  "Evidence",
  "Unresolved points",
  "Supporting files",
  "Human answers",
  "SuperAgent decisions",
]);

/** Read the same sections that the durable report renders. No JSON envelope is accepted. */
const markdownSubmission = z
  .string()
  .transform((text, context): z.input<typeof submissionSchema> => {
    function invalid(message: string) {
      context.addIssue({ code: "custom", message });
    }
    const sections = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
      const heading = /^## (.+)$/.exec(line)?.[1];
      if (heading !== undefined) {
        if (!headings.has(heading)) invalid(`Unknown report heading: ${heading}.`);
        if (sections.has(heading)) invalid(`Duplicate report heading: ${heading}.`);
        current = [];
        sections.set(heading, current);
      } else if (current !== undefined) current.push(line);
      else if (line.trim() !== "" && !line.startsWith("# "))
        invalid("Start the report with ## Conclusion.");
    }
    for (const heading of headings)
      if (!sections.has(heading)) invalid(`Missing report heading: ${heading}.`);
    function section(heading: string) {
      return sections.get(heading)?.join("\n").trim() ?? "";
    }
    function bullets(heading: string) {
      const items: string[] = [];
      for (const line of section(heading).split("\n")) {
        if (line.trim() === "" || line === "A SuperAgent decision is not a human answer.") continue;
        if (!line.startsWith("- ")) invalid(`Use - bullets in ## ${heading}.`);
        items.push(line.slice(2).trim());
      }
      return items.length === 1 && items[0] === "None." ? [] : items;
    }
    function decisions(heading: string, by: "person" | "super-agent") {
      return bullets(heading).map((item) => {
        const separator = item.indexOf(" Answer: ");
        if (separator < 0) invalid(`Use <question> Answer: <answer> in ## ${heading}.`);
        return { question: item.slice(0, separator), answer: item.slice(separator + 9), by };
      });
    }
    return {
      conclusion: section("Conclusion"),
      evidence: bullets("Evidence"),
      unresolved: bullets("Unresolved points"),
      files: bullets("Supporting files").map((file) =>
        file.startsWith("`") && file.endsWith("`") ? file.slice(1, -1) : file,
      ),
      decisions: [
        ...decisions("Human answers", "person"),
        ...decisions("SuperAgent decisions", "super-agent"),
      ],
    };
  })
  .pipe(submissionSchema);

export function parseSubmission(text: string): Submission {
  return markdownSubmission.parse(text);
}

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
