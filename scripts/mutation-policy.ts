import { parse } from "@babel/parser";

export const mutationGuidance = ".agents/skills/unit-testing/mutation-testing.md";

export function excludedUnit(name: string): boolean {
  return (
    !name.endsWith(".ts") ||
    /(?:\.test|\.spec|\.d|-fixture)\.ts$|\.generated\.|(?:^|\/)(?:fixtures?|generated|__tests__)(?:\/|$)/.test(
      name,
    )
  );
}

export function suppressionErrors(source: string): number[] {
  const { comments } = parse(source, { sourceType: "unambiguous", plugins: ["typescript"] });
  const errors: number[] = [];
  for (const comment of comments ?? []) {
    for (const [offset, raw] of comment.value.split(/\r?\n/).entries()) {
      const line = raw.replace(/^\s*\*?\s*/, "").trim();
      if (!/^Stryker\s+disable\b/.test(line)) continue;
      if (
        comment.start === 0 &&
        comment.type === "CommentLine" &&
        raw === " Stryker disable all: no logic"
      )
        continue;
      const local =
        /^Stryker disable next-line ([A-Za-z]\w*(?:\s*,\s*[A-Za-z]\w*)*): (?:equivalent|no rule):\s*\S/.exec(
          line,
        );
      if (local?.[1] && !local[1].split(",").some((name) => name.trim() === "all")) continue;
      errors.push((comment.loc?.start.line ?? 1) + offset);
    }
  }
  return errors;
}
