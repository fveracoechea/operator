import type { OperativeDispatch } from "../operative-dispatch/main.ts";
import type { SubmissionInput } from "./submission-input.ts";
import { outsideWritePaths } from "./write-paths.ts";

export type CheckoutInspection = Awaited<ReturnType<typeof OperativeDispatch.inspectCheckout>>;

/**
 * The one-commit rule of ADR 0015, as the brief states it beside the submit command.
 * The check below owns this line and its refusal name, so the brief and the refusal cannot drift.
 */
export const ONE_COMMIT_RULE = {
  refusal: "result_not_one_commit",
  rule: "A code result is exactly one commit, its parent is the base commit in the Identity section, and `code.baseCommit` and `code.resultCommit` name those two commits.",
} as const;

export type ResultCheck = "commit-shape" | "working-tree" | "write-paths";

export type ResultRefusal =
  | {
      reason: typeof ONE_COMMIT_RULE.refusal;
      // The brief renders this same line, so a caller can compare the two.
      rule: string;
      baseCommit: string;
      commits: Array<{ commit: string; parents: string[] }>;
      statedBase: string;
      statedResult: string;
    }
  | { reason: "uncommitted_work"; paths: string[] }
  | { reason: "outside_write_paths"; paths: string[]; writePaths: string[] }
  | { reason: "result_check_not_run"; check: ResultCheck; detail: string };

/**
 * Applies the authority limits of ADR 0018 to one inspection of the Operative checkout.
 * Every refusal is reported at once, in a fixed order: the commit shape, the working tree, and
 * the write paths. A check that could not run says so and never reports a pass.
 */
export function refuseResult(request: {
  inspection: CheckoutInspection;
  input: SubmissionInput;
  baseCommit: string;
  writePaths: string[];
}): ResultRefusal[] {
  const { inspection, input, baseCommit, writePaths } = request;
  const refusals: ResultRefusal[] = [];

  // A result with code revisions is one commit. Without them, nothing names a result commit,
  // and the write paths still read every commit since the base.
  let shaped = true;
  if (input.code !== null) {
    if (inspection.commits.status === "unread") {
      shaped = false;
      refusals.push({
        reason: "result_check_not_run",
        check: "commit-shape",
        detail: inspection.commits.detail,
      });
    } else {
      const commits = inspection.commits.value;
      const [newest] = commits;
      // A second commit is the parent of the newest one, so the parent check also counts them.
      shaped =
        newest !== undefined &&
        newest.parents.length === 1 &&
        newest.parents[0] === baseCommit &&
        input.code.baseCommit === baseCommit &&
        input.code.resultCommit === newest.commit;
      if (!shaped) {
        refusals.push({
          reason: ONE_COMMIT_RULE.refusal,
          rule: ONE_COMMIT_RULE.rule,
          baseCommit,
          commits,
          statedBase: input.code.baseCommit,
          statedResult: input.code.resultCommit,
        });
      }
    }
  }

  if (inspection.uncommitted.status === "unread") {
    refusals.push({
      reason: "result_check_not_run",
      check: "working-tree",
      detail: inspection.uncommitted.detail,
    });
  } else {
    // A path artifact of a non-code result is the one file that may stay uncommitted, and only
    // inside the write paths.
    const artifacts = new Set(
      input.resultKind === "non-code"
        ? input.artifacts
            .filter((one) => one.kind === "path")
            .map((one) => one.value)
            .filter((path) => outsideWritePaths([path], writePaths).length === 0)
        : [],
    );
    const paths = inspection.uncommitted.value.filter((path) => !artifacts.has(path));
    if (paths.length > 0) {
      refusals.push({ reason: "uncommitted_work", paths });
    }
  }

  if (!shaped) {
    refusals.push({
      reason: "result_check_not_run",
      check: "write-paths",
      detail: "There is no one result commit to compare with the base commit.",
    });
  } else if (inspection.changedFiles.status === "unread") {
    refusals.push({
      reason: "result_check_not_run",
      check: "write-paths",
      detail: inspection.changedFiles.detail,
    });
  } else {
    const paths = outsideWritePaths(inspection.changedFiles.value, writePaths);
    if (paths.length > 0) {
      refusals.push({ reason: "outside_write_paths", paths, writePaths });
    }
  }

  return refusals;
}
