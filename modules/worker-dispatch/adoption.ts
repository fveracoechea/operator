import { Err, Ok, fromPromise, fromSafePromise } from "unthrown";
import { z } from "zod";
import { GithubApi } from "../github-api/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { qualify, type Failure } from "./observations.ts";

export type Adoption = { number: number; url: string; draft: boolean; branch: string };

const pullRequest = z.object({
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

/**
 * Reads the adopted PR. Only an open PR whose head is the planned branch of this repository can
 * be adopted, because the owner pushes to that branch and associate finds the PR by it.
 */
export function readAdoption(input: { repository: string; number: number; branch: string }) {
  const { repository, number, branch } = input;
  return fromSafePromise(() =>
    GithubApi.call({ args: [`repos/${repository}/pulls/${number}`], timeoutMs: 60000 }),
  ).flatMap((outcome) => {
    const parsed =
      outcome.status === "succeeded" ? pullRequest.safeParse(outcome.value.body) : null;
    if (parsed?.success !== true)
      return Err<Failure>({
        reason: "adopt_pr_unreadable",
        detail: `GitHub did not answer PR #${number} of ${repository}: ${outcome.status === "succeeded" ? "an unexpected answer" : outcome.detail}. Nothing was launched.`,
      });
    const pr = parsed.data;
    if (pr.state !== "open")
      return Err<Failure>({
        reason: "adopt_pr_not_open",
        detail: `PR #${number} is ${pr.state}. Only an open PR can be adopted. Nothing was launched.`,
      });
    const head = `${pr.head.repo?.full_name ?? "a deleted repository"}:${pr.head.ref}`;
    if (head.toLowerCase() !== `${repository}:${branch}`.toLowerCase())
      return Err<Failure>({
        reason: "adopt_pr_branch_mismatch",
        detail: `PR #${number} comes from ${head}, not from ${branch} of ${repository}. Plan the PR's own branch, and adopt no PR from a fork. Nothing was launched.`,
      });
    return Ok<Adoption>({ number, url: pr.html_url, draft: pr.draft, branch });
  });
}

async function git(checkout: string, args: string[]) {
  const result = await ToolInvocation.run({
    tool: "git",
    args: ["-C", checkout, ...args],
    timeoutMs: 120000,
  });
  // Stryker disable next-line ConditionalExpression: equivalent: an invocation that did not complete has no exit code, so the exit check alone refuses it
  return result.status === "completed" && result.exitCode === 0 ? result.stdout.trim() : null;
}

/** The worktree that has the branch checked out, from Git's porcelain list. */
async function checkedOut(checkout: string, branch: string) {
  const listed = (await git(checkout, ["worktree", "list", "--porcelain"])) ?? "";
  const entry = listed
    .split("\n\n")
    .find((block) => block.split("\n").includes(`branch refs/heads/${branch}`));
  return entry?.split("\n")[0]?.replace(/^worktree /, "") ?? null;
}

/**
 * Moves an existing local branch forward to the PR head. A branch with commits that the PR lacks
 * refuses, and so does a failed count, because it could hide such commits.
 */
async function moveForward(input: {
  checkout: string;
  number: number;
  branch: string;
  tracking: string;
  head: string;
  local: string;
}) {
  const { checkout, number, branch, tracking, head, local } = input;
  const counted = await git(checkout, ["rev-list", "--count", `${head}..${local}`]);
  if (counted === null)
    return Err<Failure>({
      reason: "adopt_branch_unavailable",
      detail: `Git could not compare ${branch} with PR #${number}. Nothing was launched.`,
    });
  const ahead = Number(counted);
  if (ahead > 0)
    return Err<Failure>({
      reason: "adopt_branch_diverged",
      detail: `The local branch ${branch} has ${ahead} ${ahead === 1 ? "commit" : "commits"} that PR #${number} lacks. Push them to the PR or move them to another branch. Nothing was launched.`,
    });
  if (local === head) return Ok(undefined);
  const moved = await git(checkout, ["branch", "--quiet", "--force", branch, tracking]);
  return moved === null
    ? Err<Failure>({
        reason: "adopt_branch_unavailable",
        detail: `Git could not move ${branch} forward to ${head}. Nothing was launched.`,
      })
    : Ok(undefined);
}

/**
 * Puts the local branch at the PR head, so Herdr checks it out as it is. A missing branch is
 * created to track the remote branch, and a branch behind it moves forward. Work that only the
 * local branch or a worktree holds is never overwritten: the start refuses and names it.
 */
export function prepareBranch(input: {
  checkout: string;
  repository: string;
  number: number;
  branch: string;
}) {
  const { checkout, repository, number, branch } = input;
  return Projects.githubRemote({ checkout, repository }).flatMap((remote) =>
    fromPromise(
      async () => {
        const tracking = `refs/remotes/${remote}/${branch}`;
        const fetched =
          remote !== null &&
          (await git(checkout, [
            "fetch",
            "--no-tags",
            "--quiet",
            remote,
            `+refs/heads/${branch}:${tracking}`,
          ])) !== null;
        const head = fetched ? await git(checkout, ["rev-parse", "--verify", tracking]) : null;
        if (head === null)
          return Err<Failure>({
            reason: "adopt_branch_unavailable",
            detail: `Git could not fetch ${branch} of PR #${number} from ${remote ?? `a remote of ${repository}`}. Nothing was launched.`,
          });
        const worktree = await checkedOut(checkout, branch);
        if (worktree !== null) {
          const dirty = (await git(worktree, ["status", "--porcelain"])) !== "";
          return Err<Failure>({
            reason: dirty ? "adopt_branch_dirty" : "adopt_branch_checked_out",
            detail: `${branch} is checked out in ${worktree}${dirty ? " with uncommitted changes" : ""}. Commit and push the work it keeps, then remove that worktree or switch it to another branch. Nothing was launched.`,
          });
        }
        const local = await git(checkout, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        if (local === null) {
          const created = await git(checkout, ["branch", "--quiet", "--track", branch, tracking]);
          return created === null
            ? Err<Failure>({
                reason: "adopt_branch_unavailable",
                detail: `Git could not create ${branch} at ${head}. Nothing was launched.`,
              })
            : Ok(undefined);
        }
        return moveForward({ checkout, number, branch, tracking, head, local });
      },
      // Stryker disable next-line ConditionalExpression: equivalent: qualify passes any cause without an I/O code to defect, as the other branch does
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    ).flatMap((result) => result),
  );
}
