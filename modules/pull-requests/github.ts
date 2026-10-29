import { Err, Ok, fromPromise, type Result } from "unthrown";
import { z } from "zod";
import { ReviewRequests } from "../review-requests/main.ts";
import { GithubApi } from "../github-api/main.ts";

export type GithubReadFailure = {
  reason: "github_failed" | "github_uncertain" | "github_invalid_response";
  detail: string;
};

const author = z.object({ login: z.string() }).nullable();
const comment = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  author,
});

const pullRequestQuery = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    viewerDefaultMergeMethod
    pullRequest(number: $number) {
      state baseRefName headRefName headRefOid reviewDecision
      mergeCommit { oid }
      reviews(last: 100) { nodes { id state body url author { login } } }
      comments(last: 100) { nodes { id body url author { login } } }
      reviewThreads(last: 100) {
        totalCount
        nodes { isResolved path comments(last: 50) { nodes { id body url author { login } } } }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

const pullRequestAnswer = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
      viewerDefaultMergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]),
      pullRequest: z.object({
        state: z.enum(["OPEN", "MERGED", "CLOSED"]),
        baseRefName: z.string(),
        headRefName: z.string(),
        headRefOid: z.string(),
        reviewDecision: z.string().nullable(),
        mergeCommit: z.object({ oid: z.string() }).nullable(),
        reviews: z.object({
          nodes: z.array(comment.extend({ state: z.string() })),
        }),
        comments: z.object({ nodes: z.array(comment) }),
        reviewThreads: z.object({
          // Optional only until the CLI GitHub fixture sends it. GitHub always answers it.
          totalCount: z.number().int().optional(),
          nodes: z.array(
            z.object({
              isResolved: z.boolean(),
              path: z.string(),
              comments: z.object({ nodes: z.array(comment) }),
            }),
          ),
        }),
        commits: z.object({
          nodes: z.array(
            z.object({
              commit: z.object({
                statusCheckRollup: z
                  .object({
                    contexts: z.object({
                      totalCount: z.number().int().optional(),
                      nodes: z.array(
                        z.union([
                          z.object({
                            __typename: z.literal("CheckRun"),
                            name: z.string(),
                            status: z.string(),
                            conclusion: z.string().nullable(),
                            detailsUrl: z.string().nullable(),
                          }),
                          z.object({
                            __typename: z.literal("StatusContext"),
                            context: z.string(),
                            state: z.string(),
                            targetUrl: z.string().nullable(),
                          }),
                        ]),
                      ),
                    }),
                  })
                  .nullable(),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const associationQuery = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(headRefName: $branch, states: [OPEN], first: 10) {
      nodes { number url baseRefName headRefName headRepository { nameWithOwner } }
    }
  }
}`;

const associationAnswer = z.object({
  data: z.object({
    repository: z.object({
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
      pullRequests: z.object({
        nodes: z.array(
          z.object({
            number: z.number().int().positive(),
            url: z.string(),
            baseRefName: z.string(),
            headRefName: z.string(),
            headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
          }),
        ),
      }),
    }),
  }),
});

// The relay reads only what it needs of the stack parent, so a stacked wait stays one read heavier.
const parentQuery = `query RelayParent($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { state baseRefName headRefOid }
  }
}`;

const parentAnswer = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        state: z.enum(["OPEN", "MERGED", "CLOSED"]),
        baseRefName: z.string(),
        headRefOid: z.string(),
      }),
    }),
  }),
});

export type FeedbackItem = {
  id: string;
  kind: "review" | "comment" | "thread_comment";
  author: string | null;
  fromViewer: boolean;
  /** A review that an Operator reviewer posted, also with the owner's own account. */
  operatorReview: boolean;
  body: string;
  url: string;
  reviewState: string | null;
  path: string | null;
  threadResolved: boolean | null;
};
export type Check = { name: string; state: "pending" | "passing" | "failing"; url: string | null };
export type Observation = {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  mergeCommit: string | null;
  // The method that GitHub offers this account first. Repository settings decide which apply.
  mergeMethod: "merge" | "squash" | "rebase";
  base: string;
  defaultBranch: string | null;
  approved: boolean;
  /** Counts each thread past the read as unresolved, because the gate cannot see it. */
  unresolvedThreads: number;
  feedback: FeedbackItem[];
  checks: Check[];
  /** False when the PR has more check contexts than one read returns. */
  checksComplete: boolean;
};

const failingConclusions = [
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];

function checkRun(status: string, conclusion: string | null): Check["state"] {
  if (status !== "COMPLETED" || conclusion === null) return "pending";
  return failingConclusions.includes(conclusion) ? "failing" : "passing";
}

function statusContext(state: string): Check["state"] {
  if (state === "SUCCESS") return "passing";
  return state === "FAILURE" || state === "ERROR" ? "failing" : "pending";
}

/** Reads are not effects, but an unanswered read still leaves the result unknown. */
function query<T>(fields: string[], schema: z.ZodType<T>) {
  return fromPromise(
    () => GithubApi.call({ args: ["graphql", ...fields], timeoutMs: 60000 }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<T, GithubReadFailure> => {
    if (answer.status === "failed")
      return Err({ reason: "github_failed", detail: `${answer.code}: ${answer.detail}` });
    if (answer.status === "uncertain")
      return Err({ reason: "github_uncertain", detail: answer.detail });
    const parsed = schema.safeParse(answer.value.body);
    return parsed.success
      ? Ok(parsed.data)
      : Err({
          reason: "github_invalid_response",
          detail: "GitHub did not describe the pull request in the expected form.",
        });
  });
}

function repositoryFields(repository: string) {
  // Stryker disable next-line StringLiteral: equivalent: split always returns a first element, so the owner default is never used
  const [owner = "", name = ""] = repository.split("/");
  return ["-f", `owner=${owner}`, "-f", `name=${name}`];
}

/** Open PRs whose head is this branch in the project repository itself, never a fork. */
export function openPullRequests(repository: string, branch: string) {
  return query(
    ["-f", `query=${associationQuery}`, ...repositoryFields(repository), "-f", `branch=${branch}`],
    associationAnswer,
  ).map((answer) =>
    answer.data.repository.pullRequests.nodes
      .filter(
        (pr) =>
          pr.headRefName === branch &&
          pr.headRepository?.nameWithOwner.toLowerCase() === repository,
      )
      .map((pr) => ({
        number: pr.number,
        url: pr.url,
        base: pr.baseRefName,
        defaultBranch: answer.data.repository.defaultBranchRef?.name ?? null,
      })),
  );
}

export function observeParent(repository: string, number: number) {
  return query(
    ["-f", `query=${parentQuery}`, ...repositoryFields(repository), "-F", `number=${number}`],
    parentAnswer,
  ).map(({ data }) => ({
    state: data.repository.pullRequest.state,
    base: data.repository.pullRequest.baseRefName,
    head: data.repository.pullRequest.headRefOid,
  }));
}

/** Changes the base of the PR. An unanswered change may have landed, so the next wait reads it. */
export function retarget(repository: string, number: number, base: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: ["-X", "PATCH", `repos/${repository}/pulls/${number}`, "-f", `base=${base}`],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).map((answer) =>
    answer.status === "succeeded"
      ? null
      : answer.status === "failed"
        ? `${answer.code}: ${answer.detail}`
        : `GitHub did not answer, so the base change is unknown: ${answer.detail}`,
  );
}

/** Items past one read. The gate cannot see them, so they never count as resolved or passing. */
function unread(page: { totalCount?: number; nodes: unknown[] }) {
  return (page.totalCount ?? page.nodes.length) - page.nodes.length;
}

/** Maps one GitHub answer to the facts that the wait decision reads. */
export function observation(data: z.infer<typeof pullRequestAnswer>["data"]): Observation {
  const pr = data.repository.pullRequest;
  const viewer = data.viewer.login;
  function item(
    node: z.infer<typeof comment>,
    kind: FeedbackItem["kind"],
    extra: Pick<FeedbackItem, "reviewState" | "path" | "threadResolved">,
  ): FeedbackItem {
    const login = node.author?.login ?? null;
    return {
      id: node.id,
      kind,
      author: login,
      fromViewer: login === viewer,
      operatorReview: kind === "review" && ReviewRequests.isOperatorReview(node.body),
      body: node.body,
      url: node.url,
      ...extra,
    };
  }
  const none = { reviewState: null, path: null, threadResolved: null };
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts ?? null;
  const contexts = rollup?.nodes ?? [];
  const threads = pr.reviewThreads;
  return {
    state: pr.state,
    head: pr.headRefOid,
    mergeCommit: pr.mergeCommit?.oid ?? null,
    mergeMethod:
      data.repository.viewerDefaultMergeMethod === "MERGE"
        ? "merge"
        : data.repository.viewerDefaultMergeMethod === "SQUASH"
          ? "squash"
          : "rebase",
    base: pr.baseRefName,
    defaultBranch: data.repository.defaultBranchRef?.name ?? null,
    approved: pr.reviewDecision === "APPROVED",
    unresolvedThreads:
      threads.nodes.filter((thread) => !thread.isResolved).length + unread(threads),
    feedback: [
      ...pr.reviews.nodes.map((node) => item(node, "review", { ...none, reviewState: node.state })),
      ...pr.comments.nodes.map((node) => item(node, "comment", none)),
      ...pr.reviewThreads.nodes.flatMap((thread) =>
        thread.comments.nodes.map((node) =>
          item(node, "thread_comment", {
            ...none,
            path: thread.path,
            threadResolved: thread.isResolved,
          }),
        ),
      ),
    ],
    checksComplete: rollup === null || unread(rollup) === 0,
    checks: contexts.map((context) =>
      context.__typename === "CheckRun"
        ? {
            name: context.name,
            state: checkRun(context.status, context.conclusion),
            url: context.detailsUrl,
          }
        : {
            name: context.context,
            state: statusContext(context.state),
            url: context.targetUrl,
          },
    ),
  };
}

export function observePullRequest(repository: string, number: number) {
  return query(
    ["-f", `query=${pullRequestQuery}`, ...repositoryFields(repository), "-F", `number=${number}`],
    pullRequestAnswer,
  ).map(({ data }) => observation(data));
}

export type GithubEffectFailure = {
  reason: "github_failed" | "github_uncertain";
  detail: string;
};

/**
 * Asks GitHub to merge exactly the guarded head. GitHub refuses when the head moved. The
 * answer never proves the outcome, so the caller reads the PR again before it records a merge.
 */
export function mergePullRequest(
  repository: string,
  merge: { number: number; head: string; method: Observation["mergeMethod"] },
) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: [
          "-X",
          "PUT",
          `repos/${repository}/pulls/${merge.number}/merge`,
          "-f",
          `sha=${merge.head}`,
          "-f",
          `merge_method=${merge.method}`,
        ],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<undefined, GithubEffectFailure> => {
    if (answer.status === "failed")
      return Err({ reason: "github_failed", detail: `${answer.code}: ${answer.detail}` });
    if (answer.status === "uncertain")
      return Err({ reason: "github_uncertain", detail: answer.detail });
    return Ok(undefined);
  });
}

const refAnswer = z.object({ object: z.object({ sha: z.string() }) });

/** The commit of a remote branch, or null when the branch does not exist. */
export function remoteBranch(repository: string, branch: string) {
  return fromPromise(
    () =>
      GithubApi.call({ args: [`repos/${repository}/git/ref/heads/${branch}`], timeoutMs: 60000 }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<string | null, GithubReadFailure> => {
    if (answer.status === "failed")
      return answer.httpStatus === 404
        ? Ok(null)
        : Err({ reason: "github_failed", detail: `${answer.code}: ${answer.detail}` });
    if (answer.status === "uncertain")
      return Err({ reason: "github_uncertain", detail: answer.detail });
    const parsed = refAnswer.safeParse(answer.value.body);
    return parsed.success
      ? Ok(parsed.data.object.sha)
      : Err({
          reason: "github_invalid_response",
          detail: `GitHub did not describe the branch ${branch} in the expected form.`,
        });
  });
}

/** The caller reads the branch again after any answer, because a lost answer proves nothing. */
export function deleteRemoteBranch(repository: string, branch: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: ["-X", "DELETE", `repos/${repository}/git/refs/heads/${branch}`],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).map((answer) =>
    answer.status === "succeeded"
      ? null
      : answer.status === "failed"
        ? `${answer.code}: ${answer.detail}`
        : answer.detail,
  );
}
