import { Err, Ok, OkAsync, fromPromise } from "unthrown";
import { isCodedError } from "../../lib/coded-error.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { decideAssociation } from "./decision.ts";

function qualify<C, T>(cause: C, defect: (cause: C) => T) {
  if (
    isCodedError(cause) &&
    ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP"].includes(cause.code)
  )
    return {
      reason: "pr_io_failed",
      detail: String(cause),
      next: {
        decider: "super-agent" as const,
        question: "How should the PR worktree IO failure be corrected without losing work?",
      },
      state: { code: cause.code },
    };
  return defect(cause);
}

async function git(cwd: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", cwd, ...args],
    timeoutMs: 10000,
  });
  return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
}

/** PR-tail observations shared by association, direct entry, and review commands. */
function worktreeFacts(worktree: string) {
  return fromPromise(async () => {
    const status = await git(worktree, ["status", "--porcelain", "--untracked-files=normal"]);
    return {
      changed: status !== "",
      localHead: await git(worktree, ["rev-parse", "--verify", "HEAD"]),
    };
  }, qualify);
}

/** Authorizes the first PR association and its optional ready receipt, never a handoff. */
export const PrEntry = {
  worktreeFacts(worktree: string) {
    return worktreeFacts(worktree);
  },
  prepare(input: { worktree: string; internalReview: boolean; draft: boolean; head: string }) {
    const facts =
      input.internalReview || !input.draft
        ? worktreeFacts(input.worktree)
        : OkAsync({ changed: false, localHead: input.head });
    return facts.flatMap(({ changed, localHead }) => {
      const decision = decideAssociation({
        internalReview: input.internalReview,
        draft: input.draft,
        changed,
        localHead,
        prHead: input.head,
      });
      if (decision.result === "refused") return Err(decision);
      return Ok({
        review: decision.review,
        readiness:
          !decision.review && !input.draft
            ? { head: input.head, at: new Date().toISOString(), note: null, dispositions: [] }
            : null,
      });
    });
  },
};
