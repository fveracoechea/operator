import { expect, test } from "bun:test";
import { checkDraft, draftSchema, storedFindingsSchema } from "./draft.ts";
import type { PullRequestFacts } from "./github.ts";

const head = "a".repeat(40);
function thread(change: Record<string, unknown> = {}) {
  return {
    id: "T",
    resolved: false,
    resolvedBy: null,
    startedByViewer: true,
    comments: [],
    ...change,
  };
}
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
    comments: [],
    reviewRequests: [],
    ...change,
  };
}
function draft(change: Record<string, unknown> = {}) {
  return draftSchema.parse({ reviewedCommit: head, summary: "One line.", ...change });
}

test("the schema limits findings, short text, locations, and unknown fields", () => {
  const blocker = { short: "Broken guard", detail: "Fix it." };
  const later = { short: "Later", detail: "Later." };
  expect(draftSchema.safeParse({ reviewedCommit: head, summary: "S" }).success).toBe(true);
  for (const invalid of [
    { blockers: [blocker, blocker, blocker, blocker] },
    { niceToHaves: [1, 2, 3, 4].map(() => later) },
    { blockers: [{ ...blocker, short: "one two three four five six seven" }] },
    { niceToHaves: [{ ...later, short: "one two three four five six seven" }] },
    { niceToHaves: [{ detail: "Later." }] },
    { blockers: [{ ...blocker, path: "src/a.ts" }] },
    { niceToHaves: [{ ...later, line: 3 }] },
    { blockers: [{ ...blocker, breach: { source: "opinions", rule: "Mine." } }] },
    { blockers: [{ ...blocker, impact: "style" }] },
    { niceToHaves: [{ ...later, impact: "security" }] },
    { blockers: [{ ...blocker, source: "x".repeat(101) }] },
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
      niceToHaves: [later, later, { ...later, path: "x", line: 1 }],
    }).success,
  ).toBe(true);
});

test("each refusal names its cause and posts nothing", () => {
  const cases: [Record<string, unknown>, Partial<PullRequestFacts>, string][] = [
    [{ reviewedCommit: "b".repeat(40) }, {}, "review_head_moved"],
    [{ checks: [{ kind: "guard-break", command: "x", exitCode: 0 }] }, {}, "review_draft_invalid"],
    [
      { niceToHaves: [{ short: "S", detail: "D.", path: "src/b.ts", line: 1 }] },
      {},
      "review_draft_invalid",
    ],
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
      { threadReplies: [{ threadId: "T", kind: "explain", body: "B." }] },
      { threads: [thread({ startedByViewer: false })] },
      "review_thread_unknown",
    ],
    [
      {
        threadReplies: [
          { threadId: "T", kind: "acknowledge", body: "B." },
          { threadId: "T", kind: "explain", body: "C." },
        ],
      },
      { threads: [thread()] },
      "review_draft_invalid",
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
      draft({ niceToHaves: [{ short: "S", detail: "D.", path: "later.ts", line: 1 }] }),
      pr({ filesComplete: false }),
    ).tag,
  ).toBe("Ok");
});

test("thread replies name their outcome, and the round's commit can be older than the live head", () => {
  const reply = { threadId: "T", kind: "explain", body: "The file still stays open." };
  expect(
    checkDraft(draft({ threadReplies: [reply] }), pr({ threads: [thread({ resolved: true })] })),
  ).toMatchObject({ tag: "Ok" });
  expect(
    draftSchema.safeParse({ ...draft(), threadReplies: [{ ...reply, kind: "fixed" }] }).success,
  ).toBe(false);
  // At the head-move limit the round reviews the reviewer's head, not the live head.
  const older = "b".repeat(40);
  expect(checkDraft(draft({ reviewedCommit: older }), pr(), older)).toMatchObject({ tag: "Ok" });
  expect(checkDraft(draft(), pr(), older)).toMatchObject({
    tag: "Err",
    error: { reason: "review_head_moved" },
  });
});

function issues(change: Record<string, unknown>) {
  const parsed = draftSchema.safeParse({ reviewedCommit: head, summary: "S", ...change });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

test("a draft defaults to no findings, trims its text, and keeps one spelling of each path", () => {
  expect(draftSchema.parse({ reviewedCommit: head, summary: "  S  " })).toEqual({
    reviewedCommit: head,
    summary: "S",
    blockers: [],
    niceToHaves: [],
    threadReplies: [],
    checks: [],
    noise: [],
  });
  const paths = ["src//a.ts", "a./b.ts", "./", "dir/"].map(
    (path) =>
      draft({ niceToHaves: [{ short: "S", detail: "D.", path, line: 1 }] }).niceToHaves[0]?.path,
  );
  expect(paths).toEqual(["src/a.ts", "a./b.ts", "", "dir/"]);
  expect(
    draft({
      blockers: ["breaking", "security"].map((impact) => ({
        short: "one  two three four five six",
        detail: "D.",
        source: "  deep-modules  ",
        impact,
      })),
      checks: ["test", "lint", "typecheck", "guard-break", "other"].map((kind) => ({
        kind,
        command: "c",
        exitCode: 1,
      })),
    }).blockers.map(({ impact, source }) => ({ impact, source })),
  ).toEqual([
    { impact: "breaking", source: "deep-modules" },
    { impact: "security", source: "deep-modules" },
  ]);
});

test("each invalid draft field names its rule", () => {
  const blocker = { short: "Short", detail: "D." };
  expect(issues({ niceToHaves: [{ ...blocker, path: "/abs", line: 1 }] })).toEqual([
    "Give a path relative to the repository root, without ..",
  ]);
  expect(issues({ niceToHaves: [{ ...blocker, path: "a/../b", line: 1 }] })).toEqual([
    "Give a path relative to the repository root, without ..",
  ]);
  expect(issues({ blockers: [{ ...blocker, short: "a b c d e f g" }] })).toEqual([
    "A finding's short description has at most six words.",
  ]);
  expect(issues({ niceToHaves: [{ ...blocker, short: "a b c d e f g" }] })).toEqual([
    "A finding's short description has at most six words.",
  ]);
  expect(issues({ reviewedCommit: `x${head}` })).toEqual(["Use the full 40-character commit."]);
  expect(issues({ reviewedCommit: `${head}x` })).toEqual(["Use the full 40-character commit."]);
  expect(issues({ summary: "a\nb" })).toEqual(["Write the summary on one line."]);
  expect(issues({ niceToHaves: [{ ...blocker, line: 1 }] })).toEqual([
    "Give a finding both path and line, or neither.",
  ]);
  expect(
    draftSchema.safeParse({
      reviewedCommit: head,
      summary: "S",
      blockers: [{ ...blocker, path: "a.ts" }],
    }).error?.issues,
  ).toMatchObject([{ code: "custom" }]);
});

function refusal(change: Record<string, unknown>, facts: Partial<PullRequestFacts> = {}) {
  const checked = checkDraft(draft(change), pr(facts));
  return checked.tag === "Err" ? checked.error : null;
}

test("each refusal states its cause", () => {
  const other = "b".repeat(40);
  expect(refusal({ reviewedCommit: other })).toEqual({
    reason: "review_head_moved",
    detail: `The draft reviews ${other}, but this round reviews ${head} and the PR head is ${head}. A stale draft is not posted. Nothing was posted.`,
  });
  expect(refusal({ checks: [{ kind: "guard-break", command: "x", exitCode: 0 }] })).toEqual({
    reason: "review_draft_invalid",
    detail: "A deliberate guard break that exited 0 did not prove its guard. Nothing was posted.",
  });
  expect(refusal({ blockers: [{ short: "S", detail: "D.", path: "b.ts", line: 1 }] })).toEqual({
    reason: "review_draft_invalid",
    detail: "The finding at b.ts is not on a file that this PR changes. Nothing was posted.",
  });
  const noise = [{ check: "lint", files: ["x.ts"], reason: "R." }];
  expect(refusal({ noise }, { filesComplete: false })).toEqual({
    reason: "review_noise_unverifiable",
    detail:
      "This PR changes more files than one read returns, so a noise claim cannot be checked. Nothing was posted.",
  });
  expect(
    refusal({ noise }, { requiredChecks: [{ name: "unit", state: "failing", url: null }] }),
  ).toEqual({
    reason: "review_noise_unknown_check",
    detail: "No failing required check is named lint. Nothing was posted.",
  });
  expect(
    refusal(
      { noise: [{ check: "lint", files: ["src/a.ts"], reason: "R." }] },
      { requiredChecks: [{ name: "lint", state: "failing", url: null }] },
    ),
  ).toEqual({
    reason: "review_noise_changed_file",
    detail:
      "The noise claim cites src/a.ts, which this PR changes. A failure in a changed file is a blocker. Nothing was posted.",
  });
  expect(
    refusal(
      { threadReplies: [{ threadId: "X", kind: "explain", body: "B." }] },
      { threads: [thread()] },
    ),
  ).toEqual({
    reason: "review_thread_unknown",
    detail:
      "Thread X is not a review thread that this account started on the PR. Nothing was posted.",
  });
  const twice = [
    { threadId: "T", kind: "acknowledge", body: "B." },
    { threadId: "T", kind: "explain", body: "C." },
  ];
  expect(refusal({ threadReplies: twice }, { threads: [thread()] })).toEqual({
    reason: "review_draft_invalid",
    detail: "Reply to each thread at most once. Nothing was posted.",
  });
});

test("reported checks, findings with no location, and replies among other threads are accepted", () => {
  expect(
    refusal({
      checks: [
        { kind: "guard-break", command: "x", exitCode: 1 },
        { kind: "test", command: "y", exitCode: 0 },
      ],
      blockers: [{ short: "S", detail: "D." }],
    }),
  ).toBeNull();
  expect(
    refusal(
      { threadReplies: [{ threadId: "T", kind: "explain", body: "B." }] },
      { threads: [thread(), thread({ id: "U", startedByViewer: false })] },
    ),
  ).toBeNull();
});

test("a stored draft from an earlier release still gives its findings", () => {
  const stored = {
    reviewedCommit: head,
    summary: "S",
    blockers: [
      {
        short: "Guard untested",
        detail: "D.",
        breach: { source: "opinions", rule: "Verify every guard." },
      },
    ],
    niceToHaves: [{ detail: "Later.", path: "a.ts", line: 2 }],
  };
  expect(draftSchema.safeParse(stored).success).toBe(false);
  expect(storedFindingsSchema.parse(stored)).toEqual({
    blockers: [{ short: "Guard untested", detail: "D." }],
    niceToHaves: [{ detail: "Later.", path: "a.ts", line: 2 }],
  });
  expect(storedFindingsSchema.parse({})).toEqual({ blockers: [], niceToHaves: [] });
});
