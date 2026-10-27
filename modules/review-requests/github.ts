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
  threads: { id: string; resolved: boolean; startedByViewer: boolean }[];
  reviews: { id: string; url: string; body: string; event: string; byViewer: boolean }[];
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
        nodes { id isResolved comments(first: 1) { nodes { author { login } } } }
      }
      reviews(last: 100) { nodes { id url body state author { login } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

const author = z.object({ login: z.string() }).nullable();
const answer = z.object({
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
                comments: z.object({ nodes: z.array(z.object({ author })) }),
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
  z.infer<typeof answer>["data"]["repository"]["pullRequest"]
>["commits"]["nodes"][number]["commit"]["statusCheckRollup"];

function requiredChecks(rollup: Context): RequiredCheck[] {
  return (rollup?.contexts.nodes ?? [])
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

/** Maps one GitHub answer to the facts that a post reads, or null for an unknown form. */
export function pullRequestFacts(body: unknown): PullRequestFacts | null {
  const parsed = answer.safeParse(body);
  const pr = parsed.success ? parsed.data.data.repository.pullRequest : null;
  if (!parsed.success || pr === null) return null;
  const viewer = parsed.data.data.viewer.login;
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
      startedByViewer: thread.comments.nodes[0]?.author?.login === viewer,
    })),
    reviews: pr.reviews.nodes.map((review) => ({
      id: review.id,
      url: review.url,
      body: review.body,
      event: reviewEvent(review.state),
      byViewer: review.author?.login === viewer,
    })),
  };
}

function fields(target: Target) {
  const [owner = "", name = ""] = target.repository.split("/");
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
    const facts = pullRequestFacts(outcome.value.body);
    return facts === null
      ? Err({
          reason: "github_invalid_response",
          detail: `GitHub did not describe PR #${target.number} of ${target.repository} in the expected form.`,
        })
      : Ok(facts);
  });
}

export type PostedReview = { id: string; url: string; event: string };
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
