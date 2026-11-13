import { expect, test } from "bun:test";
import { WorkSources } from "./main.ts";

test("findings retain each field, order, and line-numbered locations", () => {
  expect(
    WorkSources.parseFindings(
      "\r\n## Findings\r\n\r\n- blocker, Spec, src/a.ts:12: Preserve the guard: it blocks writes.\r\n- nice-to-have, Standards, src/b.ts: Name the value.\r\n- blocker, Skills, docs/a.md: Cite the rule.\r\n",
    ),
  ).toMatchObject({
    tag: "Ok",
    value: [
      {
        severity: "blocker",
        axis: "Spec",
        location: "src/a.ts:12",
        claim: "Preserve the guard: it blocks writes.",
      },
      {
        severity: "nice-to-have",
        axis: "Standards",
        location: "src/b.ts",
        claim: "Name the value.",
      },
      { severity: "blocker", axis: "Skills", location: "docs/a.md", claim: "Cite the rule." },
    ],
  });
  expect(WorkSources.parseFindings("## Findings\n\n")).toMatchObject({ tag: "Ok", value: [] });
  expect(
    WorkSources.parseFindings("  ## Findings  \n  - blocker, Spec, a.ts: \r\r Claim.  \n"),
  ).toMatchObject({
    tag: "Ok",
    value: [{ severity: "blocker", axis: "Spec", location: "a.ts", claim: "Claim." }],
  });
});

test.each<[string, number]>([
  ["", 1],
  ['{"findings":[]}', 1],
  ["## Other\n", 1],
  ["\n## Findings\n## Findings\n", 3],
  ["## Findings\n- blocker, Security, a.ts: Claim.\n", 2],
  ["## Findings\n- urgent, Spec, a.ts: Claim.\n", 2],
  ["## Findings\n- blocker, Spec, : Claim.\n", 2],
  ["## Findings\n- blocker, Spec,   : Claim.\n", 2],
  ["## Findings\n- blocker, Spec, a.ts:   \n", 2],
  ["## Findings\n- blocker, Spec, a.ts: Claim.\nextra\n", 3],
  ["## Findings\n- blocker, Spec, a.ts: Claim.\n- invalid\n", 3],
  ["## Findings\nextra - blocker, Spec, a.ts: Claim.\n", 2],
  ["## Findings\n- blocker, Spec, a.ts: Claim.\rextra\n", 2],
])("invalid findings report the original line (%s)", (text, line) => {
  const result = WorkSources.parseFindings(text);
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_findings_invalid",
      next: { command: "operator pr round --file <path|->" },
    },
  });
  if (result.tag !== "Err") return expect.unreachable("malformed findings accepted");
  expect(result.error.detail).toStartWith(`Line ${line}:`);
  expect(result.error.next.why).not.toBe("");
});
