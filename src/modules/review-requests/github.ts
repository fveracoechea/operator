import { Err, Ok, fromPromise, type Result } from "unthrown";
import { z } from "zod";
import { GithubApi } from "../github-api/main.ts";

export type GithubFailure = {
  reason: "github_failed" | "github_uncertain" | "github_invalid_response";
  detail: string;
};
export type Target = { repository: string; number: number; url: string };
export type RequiredCheck = {
  name: string;
  state: "pending" | "passing" | "failing";
  url: string | null;
};
export type PullRequestFacts = {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  author: string | null;
  viewer: string;
  /** Changed paths, complete only when `filesComplete` is true. */
  files: string[];
  filesComplete: boolean;
  requiredChecks: RequiredCheck[];
  /** False when the PR has more check contexts than one read returns. */
  checksComplete: boolean;
  threads: Thread[];
  reviews: { id: string; url: string; body: string; event: string; byViewer: boolean }[];
  /** The newest PR conversation comments. */
  comments: { id: string; author: string | null; body: string; createdAt: string }[];
  /** Review requests for a user, newest last. A renewed request names the posting account. */
  reviewRequests: { reviewer: string; createdAt: string }[];
};
type ThreadComment = {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
};
export type Thread = {
  id: string;
  resolved: boolean;
  resolvedBy: string | null;
  startedByViewer: boolean;
  /** The newest comments of the thread. */
  comments: ThreadComment[];
};

/** A PR URL names its repository and number. The repository identity is case-insensitive. */
export function pullRequestTarget(text: string): Target | null {
  const match =
    /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([a-z\d._-]+)\/pull\/(\d{1,9})\/?$/i.exec(
      text,
    );
  if (match === null || match[2] === "." || match[2] === "..") return null;
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  const number = Number(match[3]);
  return number > 0
    ? { repository, number, url: `https://github.com/${repository}/pull/${number}` }
    : null;
}

const pullRequestQuery = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state headRefOid author { login }
      files(first: 100) { totalCount nodes { path } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved resolvedBy { login }
          starter: comments(first: 1) { nodes { author { login } } }
          comments(last: 50) { nodes { id body createdAt author { login } } }
        }
      }
      reviews(last: 100) { nodes { id url body state author { login } } }
      comments(last: 100) { nodes { id body createdAt author { login } } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
        nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

const author = z.object({ login: z.string() }).nullable();
export const pullRequestAnswer = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({
      pullRequest: z
        .object({
          state: z.enum(["OPEN", "MERGED", "CLOSED"]),
          headRefOid: z.string(),
          author,
          files: z.object({
            totalCount: z.number().int(),
            nodes: z.array(z.object({ path: z.string() })),
          }),
          reviewThreads: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                isResolved: z.boolean(),
                resolvedBy: author,
                starter: z.object({ nodes: z.array(z.object({ author })) }),
                comments: z.object({
                  nodes: z.array(
                    z.object({ id: z.string(), body: z.string(), createdAt: z.string(), author }),
                  ),
                }),
              }),
            ),
          }),
          reviews: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                url: z.string(),
                body: z.string(),
                state: z.string(),
                author,
              }),
            ),
          }),
          comments: z.object({
            nodes: z.array(
              z.object({ id: z.string(), body: z.string(), createdAt: z.string(), author }),
            ),
          }),
          timelineItems: z.object({
            nodes: z.array(
              z.object({
                createdAt: z.string().optional(),
                requestedReviewer: z.object({ login: z.string().optional() }).nullish(),
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
                        totalCount: z.number().int(),
                        nodes: z.array(
                          z.union([
                            z.object({
                              __typename: z.literal("CheckRun"),
                              name: z.string(),
                              status: z.string(),
                              conclusion: z.string().nullable(),
                              detailsUrl: z.string().nullable(),
                              isRequired: z.boolean(),
                            }),
                            z.object({
                              __typename: z.literal("StatusContext"),
                              context: z.string(),
                              state: z.string(),
                              targetUrl: z.string().nullable(),
                              isRequired: z.boolean(),
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
        })
        .nullable(),
    }),
  }),
});

const failingConclusions = [
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];

type Context = NonNullable<
  z.infer<typeof pullRequestAnswer>["data"]["repository"]["pullRequest"]
>["commits"]["nodes"][number]["commit"]["statusCheckRollup"];

function requiredChecks(rollup: Context): RequiredCheck[] {
  if (rollup === null) return [];
  return rollup.contexts.nodes
    .filter((node) => node.isRequired)
    .map((node) => {
      if (node.__typename === "StatusContext")
        return {
          name: node.context,
          state:
            node.state === "SUCCESS"
              ? "passing"
              : node.state === "FAILURE" || node.state === "ERROR"
                ? "failing"
                : "pending",
          url: node.targetUrl,
        };
      return {
        name: node.name,
        state:
          node.status !== "COMPLETED" || node.conclusion === null
            ? "pending"
            : failingConclusions.includes(node.conclusion)
              ? "failing"
              : "passing",
        url: node.detailsUrl,
      };
    });
}

/** GitHub names a submitted review by its state, and a post names it by its event. */
export function reviewEvent(state: string) {
  if (state === "APPROVED") return "APPROVE";
  return state === "CHANGES_REQUESTED" ? "REQUEST_CHANGES" : "COMMENT";
}

/** Maps one parsed GitHub answer to the facts that a post reads, or null when the PR is gone. */
export function pullRequestFacts(
  parsed: z.infer<typeof pullRequestAnswer>,
): PullRequestFacts | null {
  const pr = parsed.data.repository.pullRequest;
  if (pr === null) return null;
  const viewer = parsed.data.viewer.login;
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  return {
    state: pr.state,
    head: pr.headRefOid,
    author: pr.author?.login ?? null,
    viewer,
    files: pr.files.nodes.map((node) => node.path),
    filesComplete: pr.files.nodes.length === pr.files.totalCount,
    requiredChecks: requiredChecks(rollup),
    checksComplete: rollup === null || rollup.contexts.nodes.length === rollup.contexts.totalCount,
    threads: pr.reviewThreads.nodes.map((thread) => ({
      id: thread.id,
      resolved: thread.isResolved,
      resolvedBy: thread.resolvedBy?.login ?? null,
      startedByViewer: thread.starter.nodes[0]?.author?.login === viewer,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.id,
        author: comment.author?.login ?? null,
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    })),
    reviews: pr.reviews.nodes.map((review) => ({
      id: review.id,
      url: review.url,
      body: review.body,
      event: reviewEvent(review.state),
      byViewer: review.author?.login === viewer,
    })),
    comments: pr.comments.nodes.map((comment) => ({
      id: comment.id,
      author: comment.author?.login ?? null,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    // A team request has no user login, so it never names the posting account.
    reviewRequests: pr.timelineItems.nodes.flatMap((item) =>
      item.createdAt === undefined || item.requestedReviewer?.login === undefined
        ? []
        : [{ reviewer: item.requestedReviewer.login, createdAt: item.createdAt }],
    ),
  };
}

function fields(target: Target) {
  const [owner, name = ""] = target.repository.split("/");
  return ["-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${target.number}`];
}

function unanswered(
  outcome:
    | { status: "failed"; code: string; detail: string }
    | { status: "uncertain"; detail: string },
): GithubFailure {
  return outcome.status === "failed"
    ? { reason: "github_failed", detail: `${outcome.code}: ${outcome.detail}` }
    : { reason: "github_uncertain", detail: outcome.detail };
}

/** One read of the facts that a review post needs. Reads are not effects. */
export function readPullRequest(target: Target) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: ["graphql", "-f", `query=${pullRequestQuery}`, ...fields(target)],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap((outcome): Result<PullRequestFacts, GithubFailure> => {
    if (outcome.status !== "succeeded") return Err(unanswered(outcome));
    const parsed = pullRequestAnswer.safeParse(outcome.value.body);
    const facts = parsed.success ? pullRequestFacts(parsed.data) : null;
    return facts === null
      ? Err({
          reason: "github_invalid_response",
          detail: `GitHub did not describe PR #${target.number} of ${target.repository} in the expected form.`,
        })
      : Ok(facts);
  });
}

type PostedReview = { id: string; url: string; event: string };
export type PostOutcome =
  | { status: "posted"; review: PostedReview }
  | { status: "failed" | "uncertain"; detail: string };

const postedAnswer = z.object({ node_id: z.string(), html_url: z.string(), state: z.string() });

/**
 * The one GitHub write of a review. A refusal is definite. A lost answer is uncertain, because
 * GitHub may have created the review, so the caller finds it by its marker before a new post.
 */
export function postReview(
  target: Target,
  review: {
    commit: string;
    event: string;
    body: string;
    comments: { path: string; line: number; body: string }[];
  },
) {
  const payload: Record<string, unknown> = {
    commit_id: review.commit,
    event: review.event,
    body: review.body,
  };
  // A review with no inline finding sends no comment list.
  if (review.comments.length > 0)
    payload.comments = review.comments.map((comment) => ({ ...comment, side: "RIGHT" }));
  return fromPromise(
    async (): Promise<PostOutcome> => {
      const outcome = await GithubApi.call({
        args: [
          `repos/${target.repository}/pulls/${target.number}/reviews`,
          "--method",
          "POST",
          "--input",
          "-",
        ],
        input: JSON.stringify(payload),
        timeoutMs: 60000,
      });
      if (outcome.status === "failed")
        return { status: "failed", detail: `${outcome.code}: ${outcome.detail}` };
      if (outcome.status === "uncertain") return { status: "uncertain", detail: outcome.detail };
      const parsed = postedAnswer.safeParse(outcome.value.body);
      return parsed.success
        ? {
            status: "posted",
            review: {
              id: parsed.data.node_id,
              url: parsed.data.html_url,
              event: reviewEvent(parsed.data.state),
            },
          }
        : { status: "uncertain", detail: "GitHub answered the post in an unknown form." };
    },
    (cause, defect) => defect(cause),
  );
}

export type ThreadOutcome = { status: "done" } | { status: "failed" | "uncertain"; detail: string };

const replyMutation = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { id }
  }
}`;
const unresolveMutation = `mutation($thread: ID!) {
  unresolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } }
}`;
const mutationAnswer = z.object({
  data: z
    .object({
      addPullRequestReviewThreadReply: z
        .object({ comment: z.object({ id: z.string() }) })
        .optional(),
      unresolveReviewThread: z.object({ thread: z.object({ isResolved: z.boolean() }) }).optional(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/**
 * One thread write. GitHub answers a refused GraphQL write with errors, which is definite. A lost
 * answer is uncertain, so the caller reads the thread before it repeats the write.
 */
function threadWrite(args: string[], done: (answer: z.infer<typeof mutationAnswer>) => boolean) {
  return fromPromise(
    async (): Promise<ThreadOutcome> => {
      const outcome = await GithubApi.call({ args: ["graphql", ...args], timeoutMs: 60000 });
      if (outcome.status === "failed")
        return { status: "failed", detail: `${outcome.code}: ${outcome.detail}` };
      if (outcome.status === "uncertain") return { status: "uncertain", detail: outcome.detail };
      const parsed = mutationAnswer.safeParse(outcome.value.body);
      if (!parsed.success)
        return {
          status: "uncertain",
          detail: "GitHub answered a thread write in an unknown form.",
        };
      const errors = parsed.data.errors ?? [];
      if (errors.length > 0)
        return { status: "failed", detail: errors.map((error) => error.message).join(" ") };
      return done(parsed.data)
        ? { status: "done" }
        : { status: "uncertain", detail: "GitHub did not confirm the thread write." };
    },
    (cause, defect) => defect(cause),
  );
}

/** Replies once in a review thread. The body carries the marker that finds a lost reply. */
export function replyToThread(threadId: string, body: string) {
  return threadWrite(
    ["-f", `query=${replyMutation}`, "-f", `thread=${threadId}`, "-f", `body=${body}`],
    (answer) => answer.data?.addPullRequestReviewThreadReply !== undefined,
  );
}

/** Reopens a thread that its author resolved while its defect remains. */
export function unresolveThread(threadId: string) {
  return threadWrite(
    ["-f", `query=${unresolveMutation}`, "-f", `thread=${threadId}`],
    (answer) => answer.data?.unresolveReviewThread?.thread.isResolved === false,
  );
}
