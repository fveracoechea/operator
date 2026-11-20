import type { Refusal } from "../../lib/cli-result.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

type Facts = {
  internalReview: boolean;
  draft: boolean;
  changed: boolean;
  localHead: string | null;
  prHead: string;
};
type Refused = Refusal & { result: "refused" };
type Rule = { when: (facts: Facts) => boolean; refuse: (facts: Facts) => Refused };

// Either entry leaves only clean pushed work for the incoming launch. ADR-0020, ADR-0029.
const rules: Rule[] = [
  {
    when: (facts) => facts.internalReview && !facts.draft,
    refuse: () => ({
      result: "refused",
      reason: "pr_draft_required",
      detail:
        "Internal review is on, so the PR must be a draft. Convert it with gh pr ready --undo, then associate again. Nothing was changed.",
      next: {
        command: "gh pr ready --undo",
        why: "Convert the PR to a draft before associating it for internal review.",
      },
    }),
  },
  {
    when: (facts) =>
      (facts.internalReview || !facts.draft) &&
      WorkerKinds.refusesPrGuard({ guard: "worktree_clean", changed: facts.changed }),
    refuse: () => ({
      result: "refused",
      reason: "pr_worktree_unclean",
      detail:
        "Commit or remove the changed and untracked files, push, then associate again. Nothing was changed.",
      next: {
        decider: "super-agent",
        question:
          "Which local changes should be committed and pushed, or removed, before continuing the review?",
      },
    }),
  },
  {
    when: (facts) => (facts.internalReview || !facts.draft) && facts.localHead !== facts.prHead,
    refuse: (facts) => ({
      result: "refused",
      reason: "pr_worktree_unsynced",
      detail: `The worktree is at ${facts.localHead ?? "no commit"}, but the PR head is ${facts.prHead}. Push, then associate again. Nothing was changed.`,
      next: {
        decider: "super-agent",
        question: "How should the worktree and PR heads be reconciled without losing commits?",
      },
    }),
  },
];

export function decideAssociation(
  facts: Facts,
): Refused | { result: "associate"; review: boolean } {
  return (
    rules.find((rule) => rule.when(facts))?.refuse(facts) ?? {
      result: "associate",
      review: facts.internalReview,
    }
  );
}
