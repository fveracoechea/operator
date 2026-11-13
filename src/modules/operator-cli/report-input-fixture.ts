/** Markdown authored by a worker, independently of the production renderer. */
export function reportInput(value: {
  conclusion: string;
  evidence: string[];
  unresolved: string[];
  files?: string[];
  decisions?: { question: string; answer: string; by: string }[];
}) {
  function list(items: string[]) {
    return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None.";
  }
  function answers(by: string) {
    return list(
      (value.decisions ?? [])
        .filter((item) => item.by === by)
        .map((item) => `${item.question} Answer: ${item.answer}`),
    );
  }
  return `## Conclusion\n${value.conclusion}\n\n## Evidence\n${list(value.evidence)}\n\n## Unresolved points\n${list(value.unresolved)}\n\n## Supporting files\n${list(value.files ?? [])}\n\n## Human answers\n${answers("person")}\n\n## SuperAgent decisions\n${answers("super-agent")}\n`;
}
