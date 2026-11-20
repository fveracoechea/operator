import { Err, ErrAsync, Ok, fromPromise, fromSafePromise } from "unthrown";
import { z } from "zod";
import { GithubApi } from "../github-api/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { qualify, type Failure } from "./observations.ts";

export type Adoption =
  | {
      number: number;
      url: string;
      draft: boolean;
      branch: string;
      head: string;
      author: string;
      base: string;
      defaultBranch: string;
    }
  | { number: null; url: null; draft: null; branch: string; head: null };

const pullRequest = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  user: z.object({ login: z.string() }),
  base: z.object({ ref: z.string().min(1), repo: z.object({ default_branch: z.string().min(1) }) }),
  head: z.object({
    ref: z.string(),
    sha: z.string().min(1),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

/**
 * Reads the adopted PR. Only an open PR whose head is the planned branch of this repository can
 * be adopted, because the owner pushes to that branch and associate finds the PR by it.
 */
export function readAdoption(input: {
  repository: string;
  number: number | string;
  branch?: string;
  kind?: string | null;
  completion?: string;
}) {
  const { repository } = input;
  const requested = z
    .union([
      z.number().transform((number) => ({ selector: String(number), branch: input.branch })),
      z.string().transform((selector) => ({ selector, branch: undefined })),
    ])
    .parse(input.number);
  const selector = requested.selector;
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(selector);
  if (
    selector.includes("://") &&
    (url === null || url[1]?.toLowerCase() !== repository.toLowerCase())
  )
    return ErrAsync<Failure>({
      reason: "adopt_repository_mismatch",
      detail: "Adopt only a PR of this registered repository. Nothing was launched.",
      next: { decider: "super-agent", question: "Which PR belongs to this repository?" },
      state: { repositoryMatches: false },
    });
  const number =
    url !== null ? Number(url[2]) : /^[1-9]\d*$/.test(selector) ? Number(selector) : null;
  return fromSafePromise(async () => {
    const endpoint =
      number === null
        ? `repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${repository.split("/")[0]}:${selector}`)}&per_page=100`
        : `repos/${repository}/pulls/${number}`;
    return GithubApi.call({ args: [endpoint], timeoutMs: 60000 });
  })
    .flatMap((outcome) => {
      const schema = number === null ? z.array(pullRequest) : pullRequest.transform((pr) => [pr]);
      const parsed = outcome.status === "succeeded" ? schema.safeParse(outcome.value.body) : null;
      if (parsed?.success !== true)
        return Err<Failure>({
          reason: "adopt_pr_unreadable",
          next: {
            decider: "super-agent",
            question: "How should the GitHub read failure be corrected before adoption is retried?",
          },
          state: { prReadable: false },
          detail: `GitHub did not answer PR #${number} of ${repository}: ${outcome.status === "succeeded" ? "an unexpected answer" : outcome.detail}. Nothing was launched.`,
        });
      if (parsed.data.length > 1)
        return Err<Failure>({
          reason: "adopt_pr_ambiguous",
          detail:
            "More than one open PR uses the branch. Adopt a PR number instead. Nothing was launched.",
          next: { decider: "super-agent", question: "Which PR should the assignment adopt?" },
          state: { pullRequests: parsed.data.length },
        });
      const pr = parsed.data[0];
      return pr === undefined
        ? entryKind({ number: null, url: null, draft: null, branch: selector, head: null }, input)
        : prAdoption(
            pr,
            repository,
            requested.branch ?? (number === null ? selector : pr.head.ref),
          );
    })
    .flatMap((adoption) => {
      if (adoption.number === null) return Ok(adoption);
      return fromSafePromise(() => GithubApi.call({ args: ["user"], timeoutMs: 60000 })).flatMap(
        (outcome) => {
          const viewer =
            outcome.status === "succeeded"
              ? z.object({ login: z.string() }).safeParse(outcome.value.body)
              : null;
          if (viewer?.success !== true)
            return Err<Failure>({
              reason: "adopt_pr_unreadable",
              detail: "GitHub did not identify the authenticated person. Nothing was launched.",
              next: {
                decider: "super-agent",
                question: "How should GitHub authentication be restored?",
              },
              state: { viewerReadable: false },
            });
          if (adoption.author.toLowerCase() !== viewer.data.login.toLowerCase())
            return Err<Failure>({
              reason: "adopt_pr_author_mismatch",
              detail:
                "Another author's PR belongs in a review request, not adoption. Nothing was launched.",
              next: {
                command: `operator review add ${adoption.url}`,
                why: "Review another author's PR without taking push ownership.",
              },
              state: { authorMatches: false },
            });
          return entryKind(adoption, input);
        },
      );
    });
}

function prAdoption(pr: z.infer<typeof pullRequest>, repository: string, branch: string) {
  if (pr.state !== "open")
    return Err<Failure>({
      reason: "adopt_pr_not_open",
      next: { decider: "super-agent", question: "Which open PR should the assignment adopt?" },
      state: { prState: pr.state },
      detail: `PR #${pr.number} is ${pr.state}. Only an open PR can be adopted. Nothing was launched.`,
    });
  const head = `${pr.head.repo?.full_name ?? "a deleted repository"}:${pr.head.ref}`;
  if (pr.head.repo?.full_name.toLowerCase() !== repository.toLowerCase() || pr.head.ref !== branch)
    return Err<Failure>({
      reason: "adopt_pr_branch_mismatch",
      next: { decider: "super-agent", question: "Which assignment branch matches the adopted PR?" },
      state: { headMatches: false },
      detail: `PR #${pr.number} comes from ${head}, not from ${branch} of ${repository}. Plan the PR's own branch, and adopt no PR from a fork. Nothing was launched.`,
    });
  return Ok<Adoption>({
    number: pr.number,
    url: pr.html_url,
    draft: pr.draft,
    branch,
    head: pr.head.sha,
    author: pr.user.login,
    base: pr.base.ref,
    defaultBranch: pr.base.repo.default_branch,
  });
}

function entryKind(adoption: Adoption, input: { kind?: string | null; completion?: string }) {
  const kind = input.kind ?? "implementation";
  const allowed =
    adoption.number === null
      ? ["implementation"]
      : adoption.draft
        ? ["implementation", "review"]
        : ["implementation", "pr-feedback"];
  return (input.completion === undefined || input.completion === "pr") && allowed.includes(kind)
    ? Ok(adoption)
    : Err<Failure>({
        reason: "adopt_kind_invalid",
        detail: `This adoption cannot enter ${kind}. Nothing was launched.`,
        next: {
          decider: "super-agent",
          question: `Which legal entry kind should be used: ${allowed.join(" or ")}?`,
        },
        state: { kind, draft: adoption.draft },
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
  number: number | null;
  branch: string;
  tracking: string;
  head: string;
  local: string;
}) {
  const { checkout, number, branch, tracking, head, local } = input;
  const target = number === null ? "the remote branch" : `PR #${number}`;
  const counted = await git(checkout, ["rev-list", "--count", `${head}..${local}`]);
  if (counted === null)
    return Err<Failure>({
      reason: "adopt_branch_unavailable",
      next: {
        decider: "person",
        question:
          "How should local work or the checked-out adopted branch be preserved before adoption?",
      },
      state: { comparisonConfirmed: false },
      detail: `Git could not compare ${branch} with ${target}. Nothing was launched.`,
    });
  const ahead = Number(counted);
  if (ahead > 0)
    return Err<Failure>({
      reason: "adopt_branch_diverged",
      next: {
        decider: "person",
        question: "How should the diverged local and remote branches be preserved before adoption?",
      },
      state: { ahead },
      detail: `The local branch ${branch} has ${ahead} ${ahead === 1 ? "commit" : "commits"} that ${target} lacks. Push them to the PR or move them to another branch. Nothing was launched.`,
    });
  if (local === head) return Ok(undefined);
  const moved = await git(checkout, ["branch", "--quiet", "--force", branch, tracking]);
  return moved === null
    ? Err<Failure>({
        reason: "adopt_branch_unavailable",
        next: {
          decider: "person",
          question:
            "How should local work or the checked-out adopted branch be preserved before adoption?",
        },
        state: { moveConfirmed: false },
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
  number: number | null;
  branch: string;
  expectedHead?: string | null;
}) {
  const { checkout, repository, number, branch } = input;
  const target = number === null ? "the remote branch" : `PR #${number}`;
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
            next: {
              decider: "person",
              question:
                "How should local work or the checked-out adopted branch be preserved before adoption?",
            },
            state: { headResolved: false },
            detail: `Git could not fetch ${branch} of ${target} from ${remote ?? `a remote of ${repository}`}. Nothing was launched.`,
          });
        if (
          input.expectedHead !== undefined &&
          input.expectedHead !== null &&
          head !== input.expectedHead
        )
          return Err<Failure>({
            reason: "adopt_head_changed",
            detail:
              "The branch changed after GitHub's PR read. Retry adoption before launching. Nothing was launched.",
            next: {
              command: "operator next",
              why: "Retry the recorded adoption after reading the current PR head.",
            },
            state: { headChanged: true },
          });
        const worktree = await checkedOut(checkout, branch);
        if (worktree !== null) {
          const dirty = (await git(worktree, ["status", "--porcelain"])) !== "";
          return Err<Failure>({
            reason: dirty ? "adopt_branch_dirty" : "adopt_branch_checked_out",
            next: {
              decider: "person",
              question:
                "How should local work or the checked-out adopted branch be preserved before adoption?",
            },
            state: { branchCheckedOut: true },
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
                next: {
                  decider: "person",
                  question:
                    "How should local work or the checked-out adopted branch be preserved before adoption?",
                },
                state: { creationConfirmed: false },
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
