const BEGIN = "<!-- operator:instructions -->";
const END = "<!-- /operator:instructions -->";

export const instructionsSection = [
  BEGIN,
  "## Operator",
  "",
  "This project is coordinated with Operator.",
  "Load the `operator` skill before you delegate work, change the crew configuration, or run a setup operation.",
  "Operator configuration lives in `.operator/config.json`, which is local to this checkout and is not committed.",
  END,
].join("\n");

/** Returns the marked Operator section already present in a file, markers included. */
export function findInstructionsSection(text: string): string | null {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }

  return text.slice(begin, end + END.length);
}
