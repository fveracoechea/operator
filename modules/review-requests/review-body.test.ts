import { expect, test } from "bun:test";
import type { AcceptedDraft } from "./draft.ts";
import { approvalBlocked, decideEvent, renderReview } from "./review-body.ts";

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
const breach = { ...blocker, breach: { source: "opinions" as const, rule: "Verify every guard." } };

test("the event table requests changes only for a named breach and approves only with no blocker", () => {
  const other = { ownPullRequest: false, origin: "slack" };
  expect(decideEvent({ ...other, accepted: accepted() })).toBe("APPROVE");
  expect(decideEvent({ ...other, accepted: accepted({ blockers: [blocker] }) })).toBe("COMMENT");
  expect(decideEvent({ ...other, accepted: accepted({}, 1) })).toBe("COMMENT");
  expect(decideEvent({ ...other, accepted: accepted({ blockers: [blocker, breach] }) })).toBe(
    "REQUEST_CHANGES",
  );
  // The posting account's own PR and an assignment reviewer always comment.
  for (const facts of [
    { ownPullRequest: true, origin: "slack" },
    { ownPullRequest: false, origin: "assignment" },
  ]) {
    expect(decideEvent({ ...facts, accepted: accepted() })).toBe("COMMENT");
    expect(decideEvent({ ...facts, accepted: accepted({ blockers: [breach] }) })).toBe("COMMENT");
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

test("the body states status, counts, breaches, findings, and checks, with inline comments", () => {
  const rendered = renderReview({
    marker: "<!-- m -->",
    event: "REQUEST_CHANGES",
    requiredChecks: 2,
    accepted: accepted(
      {
        blockers: [{ ...breach, path: "a.ts", line: 3 }],
        niceToHaves: [{ detail: "Rename it.", path: "b.ts", line: 9 }, { detail: "Later." }],
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
      "Strong breach of the opinions: Verify every guard.",
      "**Blockers**\n1. **Guard untested.** Add a test. `a.ts:3`\n2. **CI check ci-0 fails.**",
      "**Nice to have**\n1. Rename it. `b.ts:9`\n2. Later.",
      "**Checks**\n- Required CI: 2 checks, 1 failing, 0 pending.\n- Noise: `docs` fails only in files that this PR does not change (`old.md`). Fails on main.\n- Reported test: `bun test` exited 0. 12 pass.",
    ].join("\n\n"),
  );
  expect(rendered.comments).toEqual([
    { path: "a.ts", line: 3, body: "Blocker. Guard untested. Add a test." },
    { path: "b.ts", line: 9, body: "Nice to have. Rename it." },
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
