import { expect, test } from "bun:test";
import { decideAssociation } from "./decision.ts";

const draft = {
  internalReview: true,
  draft: true,
  changed: false,
  localHead: "h1" as string | null,
  prHead: "h1",
};

test("a clean pushed draft starts internal review", () => {
  expect(decideAssociation(draft)).toEqual({ result: "associate", review: true });
});

test.each([
  [{ draft: false }, "pr_draft_required", "gh pr ready --undo"],
  [{ changed: true }, "pr_worktree_unclean", "untracked files"],
  [{ localHead: "h0" }, "pr_worktree_unsynced", "The worktree is at h0, but the PR head is h1."],
  [{ localHead: null }, "pr_worktree_unsynced", "The worktree is at no commit"],
] as const)("internal review refuses %o", (change, reason, text) => {
  const decision = decideAssociation({ ...draft, ...change });
  expect(decision).toMatchObject({ result: "refused", reason });
  if (decision.result !== "refused") return;
  expect(decision.detail).toContain(text);
  expect(decision.detail).toEndWith("Nothing was changed.");
  expect(decision.next).toEqual(
    reason === "pr_draft_required"
      ? {
          command: "gh pr ready --undo",
          why: "Convert the PR to a draft before associating it for internal review.",
        }
      : reason === "pr_worktree_unclean"
        ? {
            decider: "super-agent",
            question:
              "Which local changes should be committed and pushed, or removed, before continuing the review?",
          }
        : {
            decider: "super-agent",
            question: "How should the worktree and PR heads be reconciled without losing commits?",
          },
  );
});

test("draft then clean then pushed checks retain their refusal precedence", () => {
  expect(decideAssociation({ ...draft, draft: false, changed: true })).toMatchObject({
    reason: "pr_draft_required",
  });
  expect(decideAssociation({ ...draft, changed: true, localHead: "h0" })).toMatchObject({
    reason: "pr_worktree_unclean",
  });
});

test("ready entry without internal review requires a clean pushed head", () => {
  const ready = { ...draft, internalReview: false, draft: false };
  expect(decideAssociation({ ...ready, changed: true, localHead: "h0" })).toMatchObject({
    result: "refused",
    reason: "pr_worktree_unclean",
  });
  expect(decideAssociation({ ...ready, localHead: "unpushed" })).toMatchObject({
    result: "refused",
    reason: "pr_worktree_unsynced",
  });
  expect(decideAssociation(ready)).toEqual({ result: "associate", review: false });
});

test("an implementation draft with review off records no ready transition or worktree guard", () => {
  expect(
    decideAssociation({ ...draft, internalReview: false, changed: true, localHead: null }),
  ).toEqual({ result: "associate", review: false });
});
