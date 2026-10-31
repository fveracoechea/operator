import { expect, test } from "bun:test";
import type { AcceptedDraft } from "./draft.ts";
import {
  approvalBlocked,
  approvalWaits,
  blockerShorts,
  countBlockers,
  counts,
  decideEvent,
  inlineComments,
  markerPrefix,
  renderReview,
} from "./review-body.ts";

function accepted(change: Partial<AcceptedDraft["draft"]> = {}, failing = 0): AcceptedDraft {
  return {
    draft: {
      reviewedCommit: "a".repeat(40),
      summary: "The change keeps one owner.",
      blockers: [],
      niceToHaves: [],
      threadReplies: [],
      checks: [],
      noise: [],
      ...change,
    },
    failingChecks: Array.from({ length: failing }, (_, index) => ({
      name: `ci-${index}`,
      state: "failing" as const,
      url: null,
    })),
    pendingChecks: [],
    checksComplete: true,
  };
}
const blocker = { short: "Guard untested", detail: "Add a test." };
const breaking = { ...blocker, impact: "breaking" as const };
const security = { ...blocker, impact: "security" as const };
const styled = { ...blocker, source: "deep-modules" };

test("the event table requests changes only for a breaking or security defect", () => {
  const other = { ownPullRequest: false, origin: "slack" };
  expect(decideEvent({ ...other, accepted: accepted() })).toBe("APPROVE");
  expect(decideEvent({ ...other, accepted: accepted({ blockers: [blocker] }) })).toBe("COMMENT");
  expect(decideEvent({ ...other, accepted: accepted({}, 1) })).toBe("COMMENT");
  // A sourced breach of a skill or of the code style is a comment.
  expect(decideEvent({ ...other, accepted: accepted({ blockers: [styled] }) })).toBe("COMMENT");
  for (const defect of [breaking, security])
    expect(decideEvent({ ...other, accepted: accepted({ blockers: [blocker, defect] }) })).toBe(
      "REQUEST_CHANGES",
    );
  // The posting account's own PR and an assignment reviewer always comment.
  for (const facts of [
    { ownPullRequest: true, origin: "slack" },
    { ownPullRequest: false, origin: "assignment" },
  ]) {
    expect(decideEvent({ ...facts, accepted: accepted() })).toBe("COMMENT");
    expect(decideEvent({ ...facts, accepted: accepted({ blockers: [security] }) })).toBe("COMMENT");
  }
});

test("approval with an open blocker is refused, also for a CI blocker", () => {
  const facts = { ownPullRequest: false, origin: "slack" };
  expect(
    approvalBlocked({ ...facts, accepted: accepted({ blockers: [blocker] }) }, "APPROVE"),
  ).toBe(true);
  expect(approvalBlocked({ ...facts, accepted: accepted({}, 1) }, "APPROVE")).toBe(true);
  expect(approvalBlocked({ ...facts, accepted: accepted({}, 1) }, "COMMENT")).toBe(false);
  expect(approvalBlocked({ ...facts, accepted: accepted() }, "APPROVE")).toBe(false);
});

test("the body gives one short line for each located finding, and its line comment holds the detail", () => {
  const rendered = renderReview({
    marker: "<!-- m -->",
    event: "REQUEST_CHANGES",
    requiredChecks: 2,
    accepted: accepted(
      {
        blockers: [{ ...security, source: "ADR-0015", path: "a.ts", line: 3 }],
        niceToHaves: [
          { short: "Rename it", detail: "Name it for its use.", path: "b.ts", line: 9 },
          {
            short: "Later",
            detail: "Split the file.\n\n```ts\nexport {};\n```",
            source: "best practice",
          },
        ],
        checks: [{ kind: "test", command: "bun test", exitCode: 0, summary: "12 pass." }],
        noise: [{ check: "docs", files: ["old.md"], reason: "Fails on main." }],
      },
      1,
    ),
  });
  expect(rendered.body).toBe(
    [
      "<!-- m -->\n**Changes requested** · 2 blockers, 2 nice to haves",
      "The change keeps one owner.",
      "**Blockers**\n- **Guard untested** · security issue · `a.ts:3`\n- **CI check ci-0 fails**",
      // A finding with no line comment keeps its detail and source in the body, inside its bullet.
      "**Nice to have**\n- **Rename it** · `b.ts:9`\n- **Later**\n  Split the file.\n\n  ```ts\n  export {};\n  ```\n\n  **Source:** best practice",
      "**Checks**\n- Required CI: 2 checks, 1 failing, 0 pending.\n- Noise: `docs` fails only in files that this PR does not change (`old.md`). Fails on main.\n- Reported test: `bun test` exited 0. 12 pass.",
    ].join("\n\n"),
  );
  expect(rendered.comments).toEqual([
    {
      path: "a.ts",
      line: 3,
      body: "**Blocker: Guard untested** · security issue\n\nAdd a test.\n\n**Source:** ADR-0015",
    },
    { path: "b.ts", line: 9, body: "**Nice to have: Rename it**\n\nName it for its use." },
  ]);
});

test("a review with no finding says no blockers in its status and its body", () => {
  const comment = renderReview({
    marker: "m",
    event: "COMMENT",
    requiredChecks: 0,
    accepted: accepted(),
  });
  expect(comment.body).toBe(
    "m\n**No blockers**\n\nThe change keeps one owner.\n\nNo blockers.\n\n**Checks**\n- No required CI check reports on this PR.",
  );
  expect(comment.comments).toEqual([]);
  expect(
    renderReview({ marker: "m", event: "APPROVE", requiredChecks: 0, accepted: accepted() }).body,
  ).toStartWith("m\n**Approved**");
  expect(
    renderReview({
      marker: "m",
      event: "COMMENT",
      requiredChecks: 0,
      accepted: accepted({ blockers: [blocker] }),
    }).body,
  ).toStartWith("m\n**Needs changes** · 1 blocker");
});

test("an explained thread keeps a blocker open, so the review comments and cannot approve", () => {
  const explained = accepted({
    threadReplies: [{ threadId: "T", kind: "explain", body: "The guard is still untested." }],
  });
  const other = { ownPullRequest: false, origin: "slack" };
  expect(decideEvent({ ...other, accepted: explained })).toBe("COMMENT");
  expect(approvalBlocked({ ...other, accepted: explained }, "APPROVE")).toBe(true);
  const acknowledged = accepted({
    threadReplies: [{ threadId: "T", kind: "acknowledge", body: "Your reason holds." }],
  });
  expect(decideEvent({ ...other, accepted: acknowledged })).toBe("APPROVE");
  const { body } = renderReview({
    marker: "<!-- m -->",
    event: "COMMENT",
    accepted: explained,
    requiredChecks: 0,
  });
  expect(body).toContain("**Needs changes** · 1 blocker");
  expect(body).toContain("- **1 review thread stays open**");
  // The body, the post result, and the Slack reply count the same blocker list.
  const twice = accepted({
    threadReplies: [
      { threadId: "T", kind: "explain", body: "B." },
      { threadId: "U", kind: "explain", body: "C." },
    ],
  });
  const rendered = renderReview({
    marker: "<!-- m -->",
    event: "COMMENT",
    accepted: twice,
    requiredChecks: 0,
  });
  expect(rendered.body).toContain(`· ${countBlockers(twice)} blocker\n`);
  expect(rendered.body).toContain("- **2 review threads stay open**");
});

test("a post at the head-move limit states the older reviewed commit in its status and body", () => {
  const { body } = renderReview({
    marker: "<!-- m -->",
    event: "APPROVE",
    accepted: accepted(),
    requiredChecks: 0,
    headLimit: { reviewedCommit: "1234567890".repeat(4), head: "f".repeat(40), moves: 3 },
  });
  expect(body).toContain("**Approved** · reviewed at 1234567");
  expect(body).toContain(
    `The PR head moved 3 times during this review, so this review covers ${"1234567890".repeat(4)}, not the current head ${"f".repeat(40)}.`,
  );
  expect(
    renderReview({
      marker: "<!-- m -->",
      event: "APPROVE",
      accepted: accepted(),
      requiredChecks: 0,
    }).body,
  ).not.toContain("reviewed at");
});

test("the marker prefix starts every Operator review", () => {
  expect(markerPrefix).toBe("<!-- operator-review ");
});

test("each blocker has its short text in body order", () => {
  const explain = { threadId: "T", kind: "explain" as const, body: "B." };
  expect(blockerShorts(accepted({ blockers: [blocker], threadReplies: [explain] }, 1))).toEqual([
    "Guard untested",
    "ci-0 fails",
    "1 review thread stays open",
  ]);
  expect(
    blockerShorts(accepted({ threadReplies: [explain, { ...explain, threadId: "U" }] })),
  ).toEqual(["2 review threads stay open"]);
});

test("only an approval waits for a pending or incomplete check list", () => {
  const facts = { ownPullRequest: false, origin: "slack" };
  const pending = {
    ...accepted(),
    pendingChecks: [{ name: "b", state: "pending" as const, url: null }],
  };
  const incomplete = { ...accepted(), checksComplete: false };
  expect(approvalWaits({ ...facts, accepted: pending }, "APPROVE")).toBe(true);
  expect(approvalWaits({ ...facts, accepted: incomplete }, "APPROVE")).toBe(true);
  expect(approvalWaits({ ...facts, accepted: accepted() }, "APPROVE")).toBe(false);
  expect(approvalWaits({ ...facts, accepted: pending }, "COMMENT")).toBe(false);
});

test("the counts name only nonzero parts, in singular or plural", () => {
  expect(counts(0, 0)).toBe("");
  expect(counts(1, 1)).toBe(" · 1 blocker, 1 nice to have");
  expect(counts(2, 0)).toBe(" · 2 blockers");
  expect(counts(0, 2)).toBe(" · 2 nice to haves");
});

test("the body lists every blocker kind as a bullet, and each noise file", () => {
  const explain = { threadId: "T", kind: "explain" as const, body: "B." };
  const base = accepted(
    {
      blockers: [breaking, { short: "Second", detail: "D.\nE." }],
      threadReplies: [explain, { ...explain, threadId: "U" }],
      checks: [{ kind: "lint", command: "oxlint", exitCode: 1 }],
      noise: [{ check: "docs", files: ["a.md", "b.md"], reason: "Old." }],
    },
    0,
  );
  const { body } = renderReview({
    marker: "m",
    event: "COMMENT",
    requiredChecks: 3,
    headLimit: { reviewedCommit: "1234567890".repeat(4), head: "f".repeat(40), moves: 3 },
    accepted: {
      ...base,
      failingChecks: [
        { name: "unit", state: "failing", url: "https://ci/1" },
        { name: "e2e", state: "failing", url: null },
      ],
    },
  });
  expect(body).toBe(
    [
      "m\n**Needs changes** · 5 blockers · reviewed at 1234567",
      `The PR head moved 3 times during this review, so this review covers ${"1234567890".repeat(4)}, not the current head ${"f".repeat(40)}.`,
      "The change keeps one owner.",
      "**Blockers**\n- **Guard untested** · breaks the app\n  Add a test.\n- **Second**\n  D.\n  E.\n- **CI check unit fails** · https://ci/1\n- **CI check e2e fails**\n- **2 review threads stay open** · the thread replies explain the remaining defects",
      "**Checks**\n- Required CI: 3 checks, 2 failing, 0 pending.\n- Noise: `docs` fails only in files that this PR does not change (`a.md`, `b.md`). Old.\n- Reported lint: `oxlint` exited 1.",
    ].join("\n\n"),
  );
});

test("only a finding with both path and line gets an inline comment", () => {
  expect(
    inlineComments({
      ...accepted().draft,
      blockers: [
        { short: "A", detail: "D.", path: "a.ts" },
        { short: "B", detail: "D.", line: 1 },
        { short: "C", detail: "D." },
      ],
      niceToHaves: [
        { short: "A", detail: "D.", path: "a.ts" },
        { short: "B", detail: "D.", line: 1 },
        { short: "C", detail: "D." },
      ],
    }),
  ).toEqual([]);
});

test("a blocker with no impact and no source adds no tag and no source line", () => {
  expect(
    renderReview({
      marker: "m",
      event: "COMMENT",
      requiredChecks: 0,
      accepted: accepted({ blockers: [blocker] }),
    }).body,
  ).toBe(
    "m\n**Needs changes** · 1 blocker\n\nThe change keeps one owner.\n\n**Blockers**\n- **Guard untested**\n  Add a test.\n\n**Checks**\n- No required CI check reports on this PR.",
  );
});

test("a stored nice to have with no short still gets its line comment", () => {
  expect(
    inlineComments({
      blockers: [{ ...styled, path: "a.ts", line: 1 }],
      niceToHaves: [{ detail: "Later.", path: "a.ts", line: 2 }],
    }),
  ).toEqual([
    {
      path: "a.ts",
      line: 1,
      body: "**Blocker: Guard untested**\n\nAdd a test.\n\n**Source:** deep-modules",
    },
    { path: "a.ts", line: 2, body: "**Nice to have**\n\nLater." },
  ]);
});
