import { parse } from "@babel/parser";

/** The full CLI baseline exceeds Stryker's five-minute default; keep its initial run bounded. */
export const mutationExecutionBudget = {
  dryRunTimeoutMinutes: 30,
  // Mutant deadlines still derive from the measured clean run, plus these unchanged parameters.
  timeoutFactor: 1.5,
  timeoutMS: 2000,
  concurrency: 1,
};

export const mutationGuidance = "docs/agents/testing/mutation-testing.md";

export function excludedUnit(name: string): boolean {
  // A unit ends in .ts, so an excluded folder name is always followed by a slash.
  return (
    !name.endsWith(".ts") ||
    /(?:\.test|\.spec|\.contract|\.d|-fixture)\.ts$|\.generated\.|(?:^|\/)(?:fixtures?|generated|__tests__)\//.test(
      name,
    )
  );
}

// Each comment line can start with a block comment's leading star.
const suppression = /^\s*\*?\s*Stryker\s+disable\b/;
const explained =
  /^\s*\*?\s*Stryker disable next-line ([A-Za-z]\w*(?:\s*,\s*[A-Za-z]\w*)*): (?:equivalent|no rule):\s*\S/;

export function suppressionErrors(source: string): number[] {
  const { comments } = parse(source, { sourceType: "unambiguous", plugins: ["typescript"] });
  const errors: number[] = [];
  // Stryker disable next-line ArrayDeclaration: equivalent: Babel always returns a comments array, and the fallback only satisfies the optional type
  for (const comment of comments ?? []) {
    for (const [offset, line] of comment.value.split(/\r?\n/).entries()) {
      if (!suppression.test(line)) continue;
      if (
        comment.start === 0 &&
        comment.type === "CommentLine" &&
        line === " Stryker disable all: no logic"
      )
        continue;
      const local = explained.exec(line);
      if (local?.[1] && !local[1].split(",").some((name) => name.trim().toLowerCase() === "all"))
        continue;
      // Stryker disable next-line OptionalChaining: equivalent: Babel always sets loc on a parsed comment, and the fallback only satisfies the optional type
      errors.push((comment.loc?.start.line ?? 1) + offset);
    }
  }
  return errors;
}
