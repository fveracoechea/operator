import { Err, Ok, OkAsync, fromPromise, type AsyncOkOf, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { openPullRequests } from "./github.ts";
import { startHandoff } from "./internal-review.ts";
import { PrEntry } from "../pr-entry/main.ts";
import { qualify, resolveOwner, type Owner, type Paths } from "./owner.ts";
import type { Refusal } from "../../lib/cli-result.ts";

type Input = {
  paths: Paths;
  cwd: string;
  sourceId: string;
  assignment: string;
  launchId: string;
  number: number;
  head: string;
  personInstructed: boolean;
};
type Source = NonNullable<AsyncOkOf<ReturnType<typeof WorkSources.show>>>;
type Response = { reason: string; data: object };

function stop(result: Result<unknown, Refusal>): Result<never, Refusal> {
  // Stryker disable next-line ArrowFunction: equivalent: every caller passes only Err or Defect, so flatMap never calls its success callback
  return result.flatMap(() => stop(result));
}

function incompatible(detail: string) {
  return Err<Refusal>({
    reason: "internal_review_recovery_incompatible",
    detail,
    next: {
      command: "operator next",
      why: "Inspect the retained assignment and review before choosing recovery.",
    },
  });
}

function retained(source: Source | undefined, input: Input) {
  const detail =
    "The supplied assignment, launch, and PR do not identify one retained promoted draft. Nothing changed.";
  if (source === undefined) return incompatible(detail);
  const planned = source.planned.find((row) => row.key === input.assignment);
  const launch = source.launches.find((row) => row.id === input.launchId);
  const pr = source.pullRequests.find((row) => row.assignment === input.assignment);
  if (
    planned?.completion !== "pr" ||
    launch?.worktreePath === undefined ||
    launch.worktreePath === null ||
    pr === undefined ||
    pr.number !== input.number ||
    launch.branch !== pr.branch
  )
    return incompatible(detail);
  return Ok({ source, planned, launch: { ...launch, worktreePath: launch.worktreePath }, pr });
}

function currentOwner(input: Input, worktree: string) {
  return resolveOwner({ paths: input.paths, cwd: worktree }).flatMap((owner) =>
    owner.launchId !== input.launchId ||
    owner.sourceId !== input.sourceId ||
    owner.assignment !== input.assignment ||
    owner.pullRequest !== input.number
      ? incompatible(
          "The current worktree owner differs from the authorized recovery. Nothing changed.",
        )
      : Ok(owner),
  );
}

async function observe(input: Input, owner: Owner, url: string) {
  const found = await openPullRequests(owner.repository, owner.branch);
  if (found.tag !== "Ok") return stop(found);
  const observed = found.value[0];
  // Stryker disable next-line OptionalChaining: equivalent: openPullRequests returns a dense parsed array; length !== 1 short-circuits before observed is read unless index zero exists. The optional access narrows observed for TypeScript's noUncheckedIndexedAccess
  if (found.value.length !== 1 || observed?.number !== input.number || observed.url !== url)
    return incompatible(
      "Exactly one open PR must match the retained association. Nothing changed.",
    );
  if (!observed.draft)
    return incompatible("Recovery requires the associated PR to remain a draft. Nothing changed.");
  const tree = await PrEntry.worktreeFacts(owner.worktreePath);
  if (tree.tag !== "Ok") return stop(tree);
  return tree.value.changed || tree.value.localHead !== input.head || observed.head !== input.head
    ? incompatible(
        "Recovery requires a clean worktree at the exact authorized pushed PR head. Nothing changed.",
      )
    : Ok(owner);
}

/** Only an explicit, recorded review requirement can repair the known live-promotion defect. */
export function recoverReview(input: Input) {
  return fromPromise(async () => {
    if (!input.personInstructed)
      return Err<Refusal>({
        reason: "person_instruction_required",
        detail: "Recovery requires the person's explicit instruction. Nothing changed.",
        next: {
          decider: "person",
          question:
            "Should the missing internal review of this exact draft PR and head be recovered?",
        },
      });
    const project = await Projects.current(input);
    if (project.tag !== "Ok") return stop(project);
    const shown = await WorkSources.show({ ...input, cwd: project.value.data.checkout });
    if (shown.tag !== "Ok") return stop(shown);
    const target = retained(shown.value, input);
    if (target.tag !== "Ok") return stop(target);
    const { source, planned, launch, pr } = target.value;
    const request = {
      ...input,
      repository: project.value.data.repository,
      url: pr.url,
      branch: pr.branch,
      worktreePath: launch.worktreePath,
    };
    const audit = DeviceState.readInternalReviewRecovery(
      input.paths,
      request.repository,
      input.sourceId,
      input.assignment,
    );
    if (audit.tag !== "Ok") return stop(audit);
    if (audit.value !== null) {
      const repeated = DeviceState.recoverInternalReview(input.paths, request);
      return repeated.map(() => ({
        reason: "internal_review_recovery_unchanged",
        data: {
          sourceId: input.sourceId,
          assignment: input.assignment,
          number: input.number,
          head: input.head,
          recovery: audit.value,
        },
      }));
    }
    if ((planned.internalReview ?? source.plan.internalReview) !== true)
      return incompatible(
        "The retained assignment and plan do not prove that internal review was required. Nothing changed.",
      );
    const resolved = await currentOwner(input, launch.worktreePath);
    if (resolved.tag !== "Ok") return stop(resolved);
    const owner = resolved.value;
    const observed = await observe(input, owner, pr.url);
    if (observed.tag !== "Ok") return stop(observed);
    const recorded = DeviceState.recoverInternalReview(input.paths, request);
    if (recorded.tag !== "Ok") return stop(recorded);
    return await DeviceState.readInternalReviewRecovery(
      input.paths,
      request.repository,
      input.sourceId,
      input.assignment,
    )
      .toAsync()
      .flatMap((recovery) =>
        (recorded.value.changed ? startHandoff(input.paths, owner) : OkAsync(null)).map(() => ({
          reason: recorded.value.changed
            ? "internal_review_recovered"
            : "internal_review_recovery_unchanged",
          data: {
            sourceId: input.sourceId,
            assignment: input.assignment,
            number: input.number,
            head: input.head,
            internalReview: { state: "reviewing" },
            recovery,
          },
        })),
      );
  }, qualify).flatMap((result): Result<Response, Refusal> => result);
}
