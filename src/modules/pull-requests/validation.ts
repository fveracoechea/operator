import { ErrAsync, fromPromise, fromThrowable } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { observePullRequest } from "./github.ts";
import { owned, worktreeFacts } from "./internal-review.ts";
import { qualify, resolveOwner, type Paths } from "./owner.ts";
import { mergeConditions } from "./wait-machine.ts";

const next = {
  decider: "super-agent" as const,
  question: "How should the owner correct or document this bounded correction before delivery?",
};

/** The owner records bounded corrections, not another broad feature review or a GitHub approval. */
export function validate(input: { paths: Paths; cwd: string; file: string }) {
  return resolveOwner(input)
    .flatMap(owned)
    .flatMap((owner) => {
      const reviewedHead = owner.reviewedHead;
      const number = owner.pullRequest;
      if (
        number === null ||
        reviewedHead === null ||
        (owner.reviewState !== "ready" && owner.reviewState !== "skipped")
      )
        return ErrAsync({
          reason: "pr_validation_blocked",
          detail:
            "Validation needs an associated PR with an ended internal review and recorded reviewed head. Nothing was recorded.",
          next,
        });
      return fromPromise(
        () => (input.file === "-" ? Bun.stdin.text() : Bun.file(input.file).text()),
        qualify,
      ).flatMap((text) => {
        const summary = text.trim();
        const json = fromThrowable(
          () => {
            JSON.parse(summary);
            return true;
          },
          // Stryker disable next-line ArrowFunction: equivalent: only JSON parse success is used; a syntax failure's payload is discarded by getOr
          (cause, defect) => (cause instanceof SyntaxError ? null : defect(cause)),
        )().getOr(false);
        if (summary.length === 0 || summary.length > 4000 || json)
          return ErrAsync({
            reason: "pr_validation_blocked",
            detail:
              "Describe the bounded correction and its validation in 1 to 4000 plain-text characters, not JSON. Nothing was recorded.",
            next,
          });
        return worktreeFacts(owner.worktreePath).flatMap((facts) =>
          observePullRequest(owner.repository, number).flatMap((observed) => {
            if (
              facts.changed ||
              facts.localHead !== observed.head ||
              observed.state !== "OPEN" ||
              // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent: checksPassing depends only on observed checks; stackRelayed and reviewEnded affect only unused merge conditions
              !mergeConditions(observed, { stackRelayed: true, reviewEnded: true }).checksPassing
            )
              return ErrAsync({
                reason: "pr_validation_blocked",
                detail:
                  "Validation requires a clean pushed PR head, an open PR, and at least one current check with every check passing. Nothing was recorded.",
                next,
              });
            return fromPromise(
              () =>
                ToolInvocation.run({
                  tool: "git",
                  args: ["merge-base", "--is-ancestor", reviewedHead, observed.head],
                  cwd: owner.worktreePath,
                  timeoutMs: 10000,
                }),
              qualify,
            ).flatMap((ancestry) => {
              if (
                // Stryker disable next-line ConditionalExpression: equivalent: non-completed invocations have no exitCode, so exitCode !== 0 already rejects them
                ancestry.status !== "completed" ||
                ancestry.exitCode !== 0
              )
                return ErrAsync({
                  reason: "pr_validation_blocked",
                  detail:
                    "The reviewed head is not a known ancestor of this correction. Ask the SuperAgent to reconcile review provenance. Nothing was recorded.",
                  next,
                });
              return DeviceState.recordDeliveryValidation(input.paths, {
                launchId: owner.launchId,
                head: observed.head,
                reviewedHead,
                summary,
              }).map(() => ({
                reason: "pr_validated",
                data: {
                  sourceId: owner.sourceId,
                  assignment: owner.assignment,
                  number,
                  head: observed.head,
                  reviewedHead,
                },
                next: {
                  command: "operator pr wait --json",
                  why: "Correction validation preserves the review history; current GitHub merge guards still apply.",
                },
              }));
            });
          }),
        );
      });
    });
}
