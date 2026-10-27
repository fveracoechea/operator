import { expect, test } from "bun:test";
import { checkDraft, draftSchema } from "./draft.ts";
import type { PullRequestFacts } from "./github.ts";

const head = "a".repeat(40);
function pr(change: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    state: "OPEN",
    head,
    author: "author",
    viewer: "me",
    files: ["src/a.ts"],
    filesComplete: true,
    requiredChecks: [],
    checksComplete: true,
    threads: [],
    reviews: [],
    ...change,
  };
}
function draft(change: object = {}) {
  return draftSchema.parse({ reviewedCommit: head, summary: "One line.", ...change });
}

test("the schema limits findings, short text, locations, and unknown fields", () => {
  const blocker = { short: "Broken guard", detail: "Fix it." };
  expect(draftSchema.safeParse({ reviewedCommit: head, summary: "S" }).success).toBe(true);
  for (const invalid of [
    { blockers: [blocker, blocker, blocker, blocker] },
    { niceToHaves: [1, 2, 3, 4].map(() => ({ detail: "Later." })) },
    { blockers: [{ ...blocker, short: "one two three four five six seven" }] },
    { blockers: [{ ...blocker, path: "src/a.ts" }] },
    { niceToHaves: [{ detail: "Later.", line: 3 }] },
    { blockers: [{ ...blocker, breach: { source: "taste", rule: "Mine." } }] },
    { event: "APPROVE" },
    { summary: "Two\nlines" },
    { reviewedCommit: "abc" },
    { noise: [{ check: "lint", files: [], reason: "Old." }] },
  ])
    expect(
      draftSchema.safeParse({ reviewedCommit: head, summary: "S", ...invalid }).success,
      JSON.stringify(invalid),
    ).toBe(false);
  expect(
    draftSchema.safeParse({
      reviewedCommit: head,
      summary: "S",
      blockers: [blocker, blocker, blocker],
      niceToHaves: [{ detail: "A." }, { detail: "B." }, { detail: "C.", path: "x", line: 1 }],
    }).success,
  ).toBe(true);
});

test("each refusal names its cause and posts nothing", () => {
  const cases: [object, Partial<PullRequestFacts>, string][] = [
    [{ reviewedCommit: "b".repeat(40) }, {}, "review_head_moved"],
    [{ checks: [{ kind: "guard-break", command: "x", exitCode: 0 }] }, {}, "review_draft_invalid"],
    [{ niceToHaves: [{ detail: "D.", path: "src/b.ts", line: 1 }] }, {}, "review_draft_invalid"],
    [
      { noise: [{ check: "lint", files: ["x.ts"], reason: "R." }] },
      { filesComplete: false },
      "review_noise_unverifiable",
    ],
    [
      { noise: [{ check: "lint", files: ["x.ts"], reason: "R." }] },
      { requiredChecks: [{ name: "lint", state: "passing", url: null }] },
      "review_noise_unknown_check",
    ],
    [
      { noise: [{ check: "lint", files: ["x.ts", "src/a.ts"], reason: "R." }] },
      { requiredChecks: [{ name: "lint", state: "failing", url: null }] },
      "review_noise_changed_file",
    ],
    [
      { threadReplies: [{ threadId: "T", body: "B." }] },
      { threads: [{ id: "T", resolved: false, startedByViewer: false }] },
      "review_thread_unknown",
    ],
    [
      {
        threadReplies: [
          { threadId: "T", body: "B." },
          { threadId: "T", body: "C." },
        ],
      },
      { threads: [{ id: "T", resolved: false, startedByViewer: true }] },
      "review_draft_invalid",
    ],
    [
      { threadReplies: [{ threadId: "T", body: "B." }] },
      { threads: [{ id: "T", resolved: true, startedByViewer: true }] },
      "review_thread_replies_unsupported",
    ],
  ];
  for (const [change, facts, reason] of cases) {
    const checked = checkDraft(draft(change), pr(facts));
    expect(checked, reason).toMatchObject({ tag: "Err", error: { reason } });
    expect(checked.tag === "Err" && checked.error.detail.endsWith("Nothing was posted.")).toBe(
      true,
    );
  }
});

test("a failing required check is a blocker fact unless a valid noise claim covers it", () => {
  const checks = [
    { name: "unit", state: "failing" as const, url: "u" },
    { name: "lint", state: "failing" as const, url: null },
    { name: "build", state: "pending" as const, url: null },
    { name: "docs", state: "passing" as const, url: null },
  ];
  const accepted = checkDraft(
    draft({
      noise: [{ check: "lint", files: ["legacy.ts"], reason: "Fails on main." }],
      blockers: [{ short: "Wrong owner", detail: "Move it.", path: "src/a.ts", line: 2 }],
    }),
    pr({ requiredChecks: checks }),
  );
  expect(accepted).toMatchObject({
    tag: "Ok",
    value: {
      failingChecks: [{ name: "unit" }],
      pendingChecks: [{ name: "build" }],
    },
  });
  // A finding path is not checked when the read did not return every changed file.
  expect(
    checkDraft(
      draft({ niceToHaves: [{ detail: "D.", path: "later.ts", line: 1 }] }),
      pr({ filesComplete: false }),
    ).tag,
  ).toBe("Ok");
});
