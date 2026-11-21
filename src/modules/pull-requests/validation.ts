import { ErrAsync, fromPromise, type AsyncResult } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { PrEntry } from "../pr-entry/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { readTextInput } from "../../lib/read-text-input.ts";
import { observePullRequest, remoteBranch } from "./github.ts";
import { owned } from "./internal-review.ts";
import { qualify, resolveOwner, type Paths } from "./owner.ts";
import { mergeConditions } from "./wait-machine.ts";
import type { Refusal } from "../../lib/cli-result.ts";

function blocked(detail: string) {
  return ErrAsync<Refusal>({
    reason: "pr_validation_blocked",
    detail,
    next: {
      decider: "super-agent",
      question:
        "How should the current feedback owner document or reconcile this correction without inventing review evidence?",
    },
  });
}

/** The owner reports targeted evidence. The CLI verifies identity, checks, and ancestry only. */
export function validate(input: {
  paths: Paths;
  cwd: string;
  file: string;
}): AsyncResult<{ reason: string; data: object; next: { command: string; why: string } }, Refusal> {
  return resolveOwner(input)
    .flatMap(owned)
    .flatMap((owner) => {
      const ready = owner.readiness;
      const readyHead = ready?.head;
      const number = owner.pullRequest;
      if (
        readyHead === null ||
        readyHead === undefined ||
        number === null ||
        owner.kind === null ||
        WorkerKinds.snapshotSchema().parse(JSON.parse(owner.kind)).name !== "pr-feedback"
      )
        return blocked(
          "Validation requires the current feedback owner and an associated PR with a known ready head. Unknown historical heads remain unknown.",
        );
      return fromPromise(() => readTextInput(input.file), qualify).flatMap((text) => {
        const summary = text.trim();
        if (summary.length === 0 || summary.length > 4000 || /^[{[]/.test(summary))
          return blocked(
            "Describe the correction scope and targeted evidence references in 1 to 4000 plain-text characters, not JSON.",
          );
        return PrEntry.worktreeFacts(owner.worktreePath).flatMap((facts) =>
          observePullRequest(owner.repository, number).flatMap((observed) =>
            remoteBranch(owner.repository, owner.branch).flatMap((remote) => {
              const checks = mergeConditions(observed, {
                stackRelayed: true,
                reviewEnded: true,
              }).checksPassing;
              if (
                facts.changed ||
                facts.localHead !== observed.head ||
                remote !== observed.head ||
                observed.state !== "OPEN" ||
                !checks
              )
                return blocked(
                  "Validation requires a clean pushed exact PR head, an OPEN PR, and complete passing current checks. Nothing was recorded.",
                );
              return fromPromise(
                () =>
                  ToolInvocation.run({
                    tool: "git",
                    args: ["merge-base", "--is-ancestor", readyHead, observed.head],
                    cwd: owner.worktreePath,
                    timeoutMs: 10000,
                  }),
                qualify,
              ).flatMap((ancestry) => {
                if (ancestry.status !== "completed" || ancestry.exitCode !== 0)
                  return blocked(
                    "The known ready head must be an ancestor of this correction. Reconcile changed integration through fresh review, not validation.",
                  );
                return DeviceState.recordDeliveryValidation(input.paths, {
                  launchId: owner.launchId,
                  head: observed.head,
                  readiness: JSON.stringify(ready),
                  summary,
                })
                  .toAsync()
                  .map(() => ({
                    reason: "pr_validated",
                    data: {
                      sourceId: owner.sourceId,
                      assignment: owner.assignment,
                      number,
                      head: observed.head,
                      readyHead,
                    },
                    next: {
                      command: "operator pr wait",
                      why: "Correction evidence preserves readiness and rounds. Fresh GitHub merge guards still apply.",
                    },
                  }));
              });
            }),
          ),
        );
      });
    });
}
