import { Err, Ok, fromPromise, type Result } from "unthrown";
import { z } from "zod";
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
    pullRequest(number: $number) {
      state baseRefName headRefName headRefOid reviewDecision
      reviews(last: 100) { nodes { id state body url author { login } } }
      comments(last: 100) { nodes { id body url author { login } } }
      reviewThreads(last: 100) {
        nodes { isResolved path comments(last: 50) { nodes { id body url author { login } } } }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
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
      pullRequest: z.object({
        state: z.enum(["OPEN", "MERGED", "CLOSED"]),
        baseRefName: z.string(),
        headRefName: z.string(),
        headRefOid: z.string(),
        reviewDecision: z.string().nullable(),
        reviews: z.object({
          nodes: z.array(comment.extend({ state: z.string() })),
        }),
        comments: z.object({ nodes: z.array(comment) }),
        reviewThreads: z.object({
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
    pullRequests(headRefName: $branch, states: [OPEN], first: 10) {
      nodes { number url headRefName headRepository { nameWithOwner } }
    }
  }
}`;

const associationAnswer = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        nodes: z.array(
          z.object({
            number: z.number().int().positive(),
            url: z.string(),
            headRefName: z.string(),
            headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
          }),
        ),
      }),
    }),
  }),
});

export type FeedbackItem = {
  id: string;
  kind: "review" | "comment" | "thread_comment";
  author: string | null;
  fromViewer: boolean;
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
  base: string;
  defaultBranch: string | null;
  approved: boolean;
  unresolvedThreads: number;
  feedback: FeedbackItem[];
  checks: Check[];
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
      .map((pr) => ({ number: pr.number, url: pr.url })),
  );
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
      body: node.body,
      url: node.url,
      ...extra,
    };
  }
  const none = { reviewState: null, path: null, threadResolved: null };
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return {
    state: pr.state,
    head: pr.headRefOid,
    base: pr.baseRefName,
    defaultBranch: data.repository.defaultBranchRef?.name ?? null,
    approved: pr.reviewDecision === "APPROVED",
    unresolvedThreads: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
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
