import { expect, test } from "bun:test";
import { parseSubmission, renderReport, submissionSchema } from "./content.ts";

const submission = {
  conclusion: "Two gaps.",
  evidence: ["a.ts:10"],
  unresolved: [],
  decisions: [
    { question: "Name?", answer: "reader", by: "super-agent" },
    { question: "Scope?", answer: "a.ts only", by: "person" },
  ],
  files: ["/drafts/notes.md"],
};

test("a submission needs a conclusion and evidence, and names who answered each question", () => {
  expect(submissionSchema.parse({ ...submission, decisions: undefined, files: undefined })).toEqual(
    {
      ...submission,
      decisions: [],
      files: [],
    },
  );
  for (const invalid of [
    { ...submission, conclusion: " " },
    { ...submission, evidence: [] },
    { ...submission, files: ["relative.md"] },
    { ...submission, files: ["/a/notes.md", "/b/notes.md"] },
    { ...submission, decisions: [{ question: "Q?", answer: "A.", by: "worker" }] },
    { ...submission, extra: true },
  ])
    expect(submissionSchema.safeParse(invalid).success).toBe(false);
});

test("the report keeps human answers apart from SuperAgent decisions", () => {
  const text = renderReport({
    number: 2,
    assignment: "read",
    submission: submissionSchema.parse(submission),
    files: ["/state/reports/2/files/notes.md"],
  });
  expect(text).toContain("# Report 2 for read");
  expect(text).toContain("## Unresolved points\n\n- None.");
  expect(text).toContain("## Human answers\n\n- Scope? Answer: a.ts only\n");
  expect(text).toContain(
    "## SuperAgent decisions\n\nA SuperAgent decision is not a human answer.\n\n- Name? Answer: reader\n",
  );
  expect(text).toContain("- `/state/reports/2/files/notes.md`");
});

test("submission lines are trimmed, and supporting files need distinct absolute paths", () => {
  expect(
    submissionSchema.parse({ ...submission, evidence: [" a.ts:10 "], unresolved: [" Gap. "] }),
  ).toMatchObject({ evidence: ["a.ts:10"], unresolved: ["Gap."] });
  expect(submissionSchema.safeParse({ ...submission, evidence: ["  "] }).success).toBe(false);
  expect(
    submissionSchema.parse({ ...submission, files: ["/a/notes.md", "/b/log.md"] }).files,
  ).toEqual(["/a/notes.md", "/b/log.md"]);
  for (const [files, message] of [
    [["relative.md"], "Use absolute file paths."],
    [["/a/notes.md", "/b/notes.md"], "Supporting file names must be unique."],
  ] as const) {
    const result = submissionSchema.safeParse({ ...submission, files });
    expect(
      result.success ? [] : result.error.issues.map((issue) => [issue.code, issue.message]),
    ).toEqual([["custom", message]]);
  }
});

test("each list item is its own line", () => {
  const text = renderReport({
    number: 1,
    assignment: "read",
    submission: submissionSchema.parse({ ...submission, evidence: ["a.ts:1", "b.ts:2"] }),
    files: [],
  });
  expect(text).toContain("## Evidence\n\n- a.ts:1\n- b.ts:2\n");
  expect(text).toContain("## Supporting files\n\n- None.\n");
});

const markdown = `## Conclusion
Two gaps.

## Evidence
- a.ts:10

## Unresolved points
- None.

## Supporting files
- \`/drafts/notes.md\`

## Human answers
- Scope? Answer: a.ts only

## SuperAgent decisions
- Name? Answer: reader
`;

test("Markdown reports parse the rendered headings and authority sections", () => {
  const expected = {
    conclusion: "Two gaps.",
    evidence: ["a.ts:10"],
    unresolved: [],
    files: ["/drafts/notes.md"],
    decisions: [
      { question: "Scope?", answer: "a.ts only", by: "person" as const },
      { question: "Name?", answer: "reader", by: "super-agent" as const },
    ],
  };
  expect(parseSubmission(markdown)).toEqual(expected);
  expect(parseSubmission(markdown.replaceAll("\n", "\r\n"))).toEqual(expected);
  expect(
    parseSubmission(
      renderReport({
        number: 1,
        assignment: "read",
        submission: submissionSchema.parse(submission),
        files: submission.files,
      }),
    ),
  ).toEqual(expected);
  expect(parseSubmission(markdown.replace("`/drafts/notes.md`", "/drafts/notes.md")).files).toEqual(
    ["/drafts/notes.md"],
  );
});

test("Markdown report format errors never discard unknown content", () => {
  for (const invalid of [
    markdown.replace("## Evidence", "## Proof"),
    markdown.replace("## Evidence\n- a.ts:10\n", ""),
    `${markdown}\n## Conclusion\nReplacement`,
    `Unheaded prose\n${markdown}`,
    markdown.replace("- a.ts:10", "a.ts:10"),
    markdown.replace("Scope? Answer: a.ts only", "Scope? a.ts only"),
    markdown.replace("/drafts/notes.md", "notes.md"),
    markdown.replace("- a.ts:10", "- None."),
    JSON.stringify(submission),
  ])
    expect(() => parseSubmission(invalid)).toThrow();
});

test("report diagnostics identify missing, duplicate, and unknown sections", () => {
  expect(() => parseSubmission(`${markdown}\n## Extras\n- Hidden.`)).toThrow(
    "Unknown report heading: Extras.",
  );
  expect(() => parseSubmission(markdown.replace("## Unresolved points\n- None.\n", ""))).toThrow(
    "Missing report heading: Unresolved points.",
  );
  expect(() => parseSubmission(`${markdown}\n## Conclusion\nReplacement`)).toThrow(
    "Duplicate report heading: Conclusion.",
  );
  expect(() => parseSubmission(`Unheaded text\n${markdown}`)).toThrow(
    "Start the report with ## Conclusion.",
  );
  expect(() => parseSubmission(markdown.replace("- a.ts:10", "a.ts:10"))).toThrow(
    "Use - bullets in ## Evidence.",
  );
  expect(() =>
    parseSubmission(markdown.replace("Scope? Answer: a.ts only", "Scope? a.ts only")),
  ).toThrow("Use <question> Answer: <answer> in ## Human answers.");
});

test("the rendered authority explanation is accepted only in SuperAgent decisions", () => {
  expect(() =>
    parseSubmission(
      markdown.replace(
        "## Unresolved points\n- None.",
        "## Unresolved points\nA SuperAgent decision is not a human answer.",
      ),
    ),
  ).toThrow("Use - bullets in ## Unresolved points.");
});

test("reports keep unresolved points and trim list items without losing entries", () => {
  expect(parseSubmission(`  \n${markdown}`)).toMatchObject({ conclusion: "Two gaps." });
  expect(
    parseSubmission(
      markdown.replace(
        "## Unresolved points\n- None.",
        "## Unresolved points\n- Decide the scope.\n  ",
      ),
    ).unresolved,
  ).toEqual(["Decide the scope."]);
  expect(
    parseSubmission(markdown.replace("- `/drafts/notes.md`", "-   /drafts/notes.md  ")).files,
  ).toEqual(["/drafts/notes.md"]);
  expect(
    parseSubmission(
      markdown.replace(
        "## Unresolved points\n- None.",
        "## Unresolved points\n- None.\n- A real point.",
      ),
    ).unresolved,
  ).toEqual(["None.", "A real point."]);
  expect(
    parseSubmission(
      markdown.replace("Two gaps.", "Two gaps.\nA ## marker inside prose stays prose."),
    ).conclusion,
  ).toBe("Two gaps.\nA ## marker inside prose stays prose.");
  expect(() =>
    parseSubmission(markdown.replace("`/drafts/notes.md`", "`/drafts/notes.md")),
  ).toThrow("Use absolute file paths.");
  expect(
    parseSubmission(markdown.replace("`/drafts/notes.md`", "/drafts/notes.md`")).files,
  ).toEqual(["/drafts/notes.md`"]);
});
