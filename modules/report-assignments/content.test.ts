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
