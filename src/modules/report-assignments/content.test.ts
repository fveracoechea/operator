import { expect, test } from "bun:test";
import { renderReport, submissionSchema } from "./content.ts";

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
