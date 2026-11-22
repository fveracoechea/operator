import { Err, Ok, fromPromise, type Result, type AsyncResult } from "unthrown";
import { z } from "zod";
import { ReviewRequests } from "../review-requests/main.ts";
import { GithubApi } from "../github-api/main.ts";
import type { ResultContext } from "../../lib/cli-result.ts";

type GithubReadFailure = ResultContext & {
  reason: "github_failed" | "github_uncertain" | "github_invalid_response";
  detail: string;
};
const readRecovery = {
  decider: "super-agent" as const,
  question:
    "How should the failed or unconfirmed GitHub read be corrected before this workflow continues?",
};
const effectRecovery = {
  decider: "super-agent" as const,
  question:
    "How should GitHub's current state be inspected before repeating the unconfirmed request?",
};

const author = z.object({ login: z.string() }).nullable();
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const comment = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  author,
  updatedAt: z.string().optional(),
});

const pullRequestFields = `
      state isDraft baseRefName headRefName headRefOid reviewDecision mergeQueueEntry { id }
      mergeCommit { oid }
      reviews(first: 100) { pageInfo { hasNextPage endCursor } nodes { id state body url updatedAt author { login } } }
      comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { id body url updatedAt author { login } } }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage endCursor }
        totalCount
        nodes { id isResolved path comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { id body url updatedAt author { login } } } }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { id name status conclusion detailsUrl startedAt completedAt }
        ... on StatusContext { id context state targetUrl createdAt }
      } } } } } }
`;
const pullRequestQuery = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    viewerDefaultMergeMethod
    pullRequest(number: $number) { ${pullRequestFields} }
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
        isDraft: z.boolean(),
        reviewDecision: z.string().nullable(),
        mergeCommit: z.object({ oid: z.string() }).nullable(),
        mergeQueueEntry: z.object({ id: z.string() }).nullable(),
        reviews: z.object({
          pageInfo: pageInfo.optional(),
          nodes: z.array(comment.extend({ state: z.string() })),
        }),
        comments: z.object({ nodes: z.array(comment), pageInfo: pageInfo.optional() }),
        reviewThreads: z.object({
          pageInfo: pageInfo.optional(),
          totalCount: z.number().int(),
          nodes: z.array(
            z.object({
              id: z.string().optional(),
              isResolved: z.boolean(),
              path: z.string(),
              comments: z.object({ nodes: z.array(comment), pageInfo: pageInfo.optional() }),
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
                            id: z.string().optional(),
                            startedAt: z.string().nullable().optional(),
                            completedAt: z.string().nullable().optional(),
                            name: z.string(),
                            status: z.string(),
                            conclusion: z.string().nullable(),
                            detailsUrl: z.string().nullable(),
                          }),
                          z.object({
                            __typename: z.literal("StatusContext"),
                            id: z.string().optional(),
                            createdAt: z.string().optional(),
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
      nodes { number url isDraft baseRefName headRefName headRefOid headRepository { nameWithOwner } }
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
            isDraft: z.boolean(),
            baseRefName: z.string(),
            headRefName: z.string(),
            headRefOid: z.string(),
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
  version?: string;
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

export type Check = {
  name: string;
  state: "pending" | "passing" | "failing";
  url: string | null;
  generation?: string;
};

export type Observation = {
  queueEntry?: string | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  mergeCommit: string | null;
  // The method that GitHub offers this account first. Repository settings decide which apply.
  mergeMethod: "merge" | "squash" | "rebase";
  base: string;
  defaultBranch: string | null;
  draft: boolean;
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
  if (failingConclusions.includes(conclusion)) return "failing";
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) ? "passing" : "pending";
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
      return Err({
        reason: "github_failed",
        detail: `${answer.code}: ${answer.detail}`,
        next: readRecovery,
        state: { code: answer.code },
      });
    if (answer.status === "uncertain")
      return Err({
        reason: "github_uncertain",
        detail: answer.detail,
        next: readRecovery,
        state: { requestStatus: answer.status },
      });
    const parsed = z
      .intersection(z.looseObject({ errors: z.array(z.unknown()).max(0).optional() }), schema)
      .safeParse(answer.value.body);
    return parsed.success
      ? Ok(parsed.data)
      : Err({
          reason: "github_invalid_response",
          detail: "GitHub did not describe the pull request in the expected form.",
          next: readRecovery,
          state: { responseValid: false },
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
        draft: pr.isDraft,
        head: pr.headRefOid,
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
function unread(page: { totalCount: number; nodes: unknown[] }) {
  return page.totalCount - page.nodes.length;
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
    const feedback: FeedbackItem = {
      id: node.id,
      kind,
      author: login,
      fromViewer: login === viewer,
      operatorReview: kind === "review" && ReviewRequests.isOperatorReview(node.body),
      body: node.body,
      url: node.url,
      ...extra,
    };
    if (node.updatedAt !== undefined)
      feedback.version = JSON.stringify([
        node.updatedAt,
        node.body,
        extra.reviewState,
        extra.threadResolved,
      ]);
    return feedback;
  }

  const none = { reviewState: null, path: null, threadResolved: null };
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts ?? null;
  const contexts = rollup?.nodes ?? [];
  const threads = pr.reviewThreads;
  const observed: Observation = {
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
    draft: pr.isDraft,
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
    checksComplete: rollup !== null && unread(rollup) === 0,
    checks: contexts.map((context): Check => {
      const check: Check =
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
            };
      if (context.id !== undefined)
        check.generation =
          context.__typename === "CheckRun"
            ? JSON.stringify([context.id, context.startedAt, context.completedAt])
            : JSON.stringify([context.id, context.createdAt]);
      return check;
    }),
  };
  observed.queueEntry = pr.mergeQueueEntry === null ? null : pr.mergeQueueEntry.id;
  return observed;
}

export function observePullRequest(repository: string, number: number) {
  return query(
    ["-f", `query=${pullRequestQuery}`, ...repositoryFields(repository), "-F", `number=${number}`],
    pullRequestAnswer,
  ).flatMap(({ data }) =>
    completeFeedback([{ repository, number, parent: null }], [data.repository]).map(() =>
      observation(data),
    ),
  );
}

type ParkedTarget = {
  repository: string;
  number: number;
  parent: number | null;
  parents?: number[];
};
const batchRepository = pullRequestAnswer.shape.data.shape.repository
  .extend({
    parent: parentAnswer.shape.data.shape.repository.shape.pullRequest.optional(),
  })
  .passthrough();
type BatchRepository = z.infer<typeof batchRepository>;
const connections = ["reviews", "comments", "reviewThreads"] as const;

function incompleteFeedback(): GithubReadFailure {
  return {
    reason: "github_invalid_response",
    detail:
      "GitHub feedback pages were incomplete, repeated a cursor, or changed head. No observation cursors changed.",
    next: readRecovery,
  };
}

function feedbackSelection(target: ParkedTarget, index: number, repository?: BatchRepository) {
  const [owner, name] = target.repository.split("/");
  let fields = pullRequestFields;
  for (const connection of connections) {
    const page = repository?.pullRequest[connection].pageInfo;
    if (page?.hasNextPage && page.endCursor !== null)
      fields = fields.replace(
        `${connection}(first: 100)`,
        `${connection}(first: 100, after: ${JSON.stringify(page.endCursor)})`,
      );
  }
  return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    defaultBranchRef { name } viewerDefaultMergeMethod pullRequest(number: ${target.number}) { ${fields} }
    ${(target.parents ?? (target.parent === null ? [] : [target.parent])).map((number, at) => `${at === 0 ? "parent" : `parent${at}`}: pullRequest(number: ${number}) { state baseRefName headRefOid }`).join("\n")}
  }`;
}

function feedbackPending(repository: BatchRepository) {
  return connections.some((connection) => repository.pullRequest[connection].pageInfo?.hasNextPage);
}

function appendFeedback(
  previous: BatchRepository,
  next: BatchRepository,
  cursors: Map<object, Set<string>>,
): Result<undefined, GithubReadFailure> {
  if (previous.pullRequest.headRefOid !== next.pullRequest.headRefOid)
    return Err(incompleteFeedback());
  for (const connection of connections) {
    const page = previous.pullRequest[connection];
    if (!page.pageInfo?.hasNextPage) continue;
    const read = next.pullRequest[connection];
    if (!advancePage(page, read.pageInfo, cursors)) return Err(incompleteFeedback());
    // Keep the parsed connection types correlated rather than mixing review and thread nodes.
    if (connection === "reviews")
      previous.pullRequest.reviews.nodes.push(...next.pullRequest.reviews.nodes);
    if (connection === "comments")
      previous.pullRequest.comments.nodes.push(...next.pullRequest.comments.nodes);
    if (connection === "reviewThreads")
      previous.pullRequest.reviewThreads.nodes.push(...next.pullRequest.reviewThreads.nodes);
    page.pageInfo = read.pageInfo;
  }
  return Ok(undefined);
}

/** Cursor identity belongs to one connection, including its terminal response. */
function advancePage(
  connection: { pageInfo?: z.infer<typeof pageInfo> },
  next: z.infer<typeof pageInfo> | undefined,
  cursors: Map<object, Set<string>>,
) {
  const previous = connection.pageInfo?.endCursor;
  if (previous === undefined || previous === null || next === undefined) return false;
  const seen = cursors.get(connection) ?? new Set([previous]);
  if (next.endCursor === null) return !next.hasNextPage;
  if (seen.has(next.endCursor)) return false;
  seen.add(next.endCursor);
  cursors.set(connection, seen);
  return true;
}

/** Continuation requests remain device batches. No per-PR polling or schedule lives here. */
function completeFeedback(
  targets: ParkedTarget[],
  repositories: BatchRepository[],
): AsyncResult<undefined, GithubReadFailure> {
  return fromPromise(
    async () => {
      const cursors = new Map<object, Set<string>>();
      for (const repository of repositories)
        for (const connection of connections) {
          const page = repository.pullRequest[connection];
          if (page.pageInfo === undefined && page.nodes.length >= 100)
            return Err(incompleteFeedback());
          if (page.pageInfo?.hasNextPage && page.pageInfo.endCursor === null)
            return Err(incompleteFeedback());
        }
      for (let round = 0; repositories.some(feedbackPending); round++) {
        if (round >= 1000) return Err(incompleteFeedback());
        const selections = targets.map((target, index) =>
          feedbackSelection(target, index, repositories[index]),
        );
        const read = await query(
          ["-f", `query=query ParkedFeedbackPages { ${selections.join("\n")} }`],
          z.object({ data: z.looseObject({}) }),
        );
        if (read.tag !== "Ok") return read.map(() => undefined);
        for (const [index, previous] of repositories.entries()) {
          const next = batchRepository.safeParse(read.value.data[`r${index}`]);
          if (!next.success) return Err(incompleteFeedback());
          const appended = appendFeedback(previous, next.data, cursors);
          if (appended.tag !== "Ok") return appended;
        }
      }
      return completeThreadComments(repositories);
    },
    (cause, defect) => defect(cause),
  ).flatMap((result) => result);
}

const threadPage = z.object({
  pullRequest: z.object({ headRefOid: z.string() }),
  comments: z.object({ pageInfo, nodes: z.array(comment) }),
});
function completeThreadComments(
  repositories: BatchRepository[],
): AsyncResult<undefined, GithubReadFailure> {
  return fromPromise(
    async () => {
      const cursors = new Map<object, Set<string>>();
      const threads = repositories.flatMap((repository) =>
        repository.pullRequest.reviewThreads.nodes.map((thread) => ({
          thread,
          head: repository.pullRequest.headRefOid,
        })),
      );
      if (
        threads.some(
          ({ thread }) =>
            thread.comments.pageInfo === undefined && thread.comments.nodes.length >= 100,
        )
      )
        return Err(incompleteFeedback());
      for (let round = 0; ; round++) {
        const pending = threads.filter(({ thread }) => thread.comments.pageInfo?.hasNextPage);
        if (pending.length === 0) return Ok(undefined);
        if (
          round >= 1000 ||
          pending.some(
            ({ thread }) => thread.id === undefined || thread.comments.pageInfo?.endCursor === null,
          )
        )
          return Err(incompleteFeedback());
        const selections = pending.map(
          (
            { thread },
            index,
          ) => `t${index}: node(id: ${JSON.stringify(thread.id)}) { ... on PullRequestReviewThread {
        pullRequest { headRefOid } comments(first: 100, after: ${JSON.stringify(thread.comments.pageInfo?.endCursor)}) { pageInfo { hasNextPage endCursor } nodes { id body url updatedAt author { login } } }
      } }`,
        );
        const read = await query(
          ["-f", `query=query ParkedThreadPages { ${selections.join("\n")} }`],
          z.object({ data: z.record(z.string(), threadPage) }),
        );
        if (read.tag !== "Ok") return read.map(() => undefined);
        for (const [index, { thread, head }] of pending.entries()) {
          const next = read.value.data[`t${index}`];
          if (
            next === undefined ||
            next.pullRequest.headRefOid !== head ||
            !advancePage(thread.comments, next.comments.pageInfo, cursors)
          )
            return Err(incompleteFeedback());
          thread.comments.nodes.push(...next.comments.nodes);
          thread.comments.pageInfo = next.comments.pageInfo;
        }
      }
    },
    (cause, defect) => defect(cause),
  ).flatMap((result) => result);
}

/** All parked assignments and their recorded parents share one GitHub read, not one request per PR. */
export function observeParkedPullRequests(targets: ParkedTarget[]) {
  const selections = targets.map((target, index) => feedbackSelection(target, index));
  return query(
    ["-f", `query=query ParkedPRs { viewer { login } ${selections.join("\n")} }`],
    z.object({ data: z.looseObject({ viewer: z.object({ login: z.string() }) }) }),
  )
    .flatMap(
      ({
        data,
      }): Result<
        { repositories: BatchRepository[]; viewer: { login: string } },
        GithubReadFailure
      > => {
        const repositories: BatchRepository[] = [];
        for (let index = 0; index < targets.length; index++) {
          const parsed = batchRepository.safeParse(data[`r${index}`]);
          if (
            !parsed.success ||
            (targets[index]?.parent !== null && parsed.data.parent === undefined)
          )
            return Err({
              reason: "github_invalid_response",
              detail:
                "GitHub did not describe every parked PR and recorded parent. No cursors changed.",
              next: readRecovery,
            });
          const repository = parsed.data;
          const parents = targets[index]?.parents ?? [];
          for (let at = 0; at < parents.length; at++) {
            const node = parentAnswer.shape.data.shape.repository.shape.pullRequest.safeParse(
              repository[at === 0 ? "parent" : `parent${at}`],
            );
            if (!node.success) return Err(incompleteFeedback());
          }
          if (!observation({ viewer: data.viewer, repository }).checksComplete)
            return Err({
              reason: "github_invalid_response",
              detail:
                "GitHub returned an incomplete check set for a parked PR. No cursors changed; inspect the full checks before retrying the batch.",
              next: readRecovery,
            });
          repositories.push(repository);
        }
        return Ok({ repositories, viewer: data.viewer });
      },
    )
    .flatMap(({ repositories, viewer }) =>
      completeFeedback(targets, repositories).map(() =>
        repositories.map((repository, index) => ({
          observed: observation({ viewer, repository }),
          parent:
            repository.parent === undefined
              ? null
              : {
                  state: repository.parent.state,
                  head: repository.parent.headRefOid,
                  base: repository.parent.baseRefName,
                },
          parents: (targets[index]?.parents ?? []).map((number, at) => {
            const parent = parentAnswer.shape.data.shape.repository.shape.pullRequest.parse(
              repository[at === 0 ? "parent" : `parent${at}`],
            );
            return {
              number,
              state: parent.state,
              head: parent.headRefOid,
              base: parent.baseRefName,
            };
          }),
        })),
      ),
    );
}

type GithubEffectFailure = ResultContext & {
  reason: "github_failed" | "github_uncertain";
  detail: string;
};

const mergeRequestAnswer = z.object({
  status: z.enum(["pending", "merged", "enqueued", "failed"]),
  details: z.object({ message: z.string(), uuid: z.string().optional() }),
});

/** A merge request's state: `pending` runs in the background, and the others are final. */
export type MergeRequest = {
  status: z.infer<typeof mergeRequestAnswer>["status"];
  uuid: string | null;
  message: string;
};

function mergeRequestResult(answer: Awaited<ReturnType<typeof GithubApi.call>>) {
  // GitHub answers 409 while an earlier request for this PR still runs, and the gh failure
  // keeps no uuid to read, so the merge stays pending for the caller to verify.
  if (answer.status === "failed" && answer.httpStatus === 409)
    return Ok<MergeRequest>({
      status: "pending",
      uuid: null,
      message: "GitHub already runs a merge request for this PR.",
    });
  if (answer.status === "failed")
    return Err<GithubEffectFailure>({
      reason: "github_failed",
      detail: `${answer.code}: ${answer.detail}`,
      next: effectRecovery,
    });
  if (answer.status === "uncertain")
    return Err<GithubEffectFailure>({
      reason: "github_uncertain",
      detail: answer.detail,
      next: effectRecovery,
    });
  const parsed = mergeRequestAnswer.safeParse(answer.value.body);
  // An unreadable answer can follow an accepted request, so the merge stays uncertain.
  return parsed.success
    ? Ok<MergeRequest>({
        status: parsed.data.status,
        uuid: parsed.data.details.uuid ?? null,
        message: parsed.data.details.message,
      })
    : Err<GithubEffectFailure>({
        reason: "github_uncertain",
        detail: "GitHub did not describe the merge request in the expected form.",
        next: effectRecovery,
      });
}

/**
 * Asks GitHub to merge exactly the guarded head, without a merge queue. The asynchronous
 * endpoint merges every PR, also one that GitHub keeps in a stack, which the synchronous
 * endpoint refuses. The answer never proves the outcome, so the caller reads the PR again before
 * it records a merge.
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
          `repos/${repository}/pulls/${merge.number}/merge-async`,
          "-f",
          `sha=${merge.head}`,
          "-f",
          `merge_method=${merge.method}`,
          "-f",
          "merge_action=direct_merge",
        ],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap(mergeRequestResult);
}

/** The current state of one background merge request. */
export function readMergeRequest(repository: string, number: number, uuid: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: [`repos/${repository}/pulls/${number}/merge-async/${uuid}`],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap(mergeRequestResult);
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
        : Err({
            reason: "github_failed",
            detail: `${answer.code}: ${answer.detail}`,
            next: readRecovery,
            state: { code: answer.code },
          });
    if (answer.status === "uncertain")
      return Err({
        reason: "github_uncertain",
        detail: answer.detail,
        next: readRecovery,
        state: { requestStatus: answer.status },
      });
    const parsed = refAnswer.safeParse(answer.value.body);
    return parsed.success
      ? Ok(parsed.data.object.sha)
      : Err({
          reason: "github_invalid_response",
          detail: `GitHub did not describe the branch ${branch} in the expected form.`,
          next: readRecovery,
          state: { responseValid: false },
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

// The ready step and the skip read the PR's node, draft state, and earlier comments.
const readyQuery = `query ReadyFacts($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id state isDraft headRefOid
      comments(last: 100) { nodes { id body url author { login } } }
    }
  }
}`;

const readyAnswer = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({
      pullRequest: z.object({
        id: z.string(),
        state: z.enum(["OPEN", "MERGED", "CLOSED"]),
        isDraft: z.boolean(),
        headRefOid: z.string(),
        comments: z.object({ nodes: z.array(comment) }),
      }),
    }),
  }),
});

/** The PR as the ready step needs it, with the viewer's own comment that holds the marker. */
export function readyFacts(repository: string, number: number, marker: string) {
  return query(
    ["-f", `query=${readyQuery}`, ...repositoryFields(repository), "-F", `number=${number}`],
    readyAnswer,
  ).map(({ data }) => {
    const pr = data.repository.pullRequest;
    const posted = pr.comments.nodes.find(
      (node) => node.author?.login === data.viewer.login && node.body.includes(marker),
    );
    return {
      id: pr.id,
      state: pr.state,
      draft: pr.isDraft,
      head: pr.headRefOid,
      posted: posted === undefined ? null : { id: posted.id, url: posted.url, body: posted.body },
    };
  });
}

const postedAnswer = z.object({ node_id: z.string(), html_url: z.string() });

/** Posts one PR comment. A lost answer is found again by its marker on the next read. */
export function postComment(repository: string, number: number, body: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: [`repos/${repository}/issues/${number}/comments`, "--method", "POST", "--input", "-"],
        input: JSON.stringify({ body }),
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<{ id: string; url: string }, GithubEffectFailure> => {
    if (answer.status === "failed")
      return Err({
        reason: "github_failed",
        detail: `${answer.code}: ${answer.detail}`,
        next: effectRecovery,
      });
    if (answer.status === "uncertain")
      return Err({ reason: "github_uncertain", detail: answer.detail, next: effectRecovery });
    const parsed = postedAnswer.safeParse(answer.value.body);
    return parsed.success
      ? Ok({ id: parsed.data.node_id, url: parsed.data.html_url })
      : Err({
          reason: "github_uncertain",
          detail: "GitHub answered the comment post in an unknown form.",
          next: effectRecovery,
        });
  });
}

const updateMutation = `mutation($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } }
}`;

const updateAnswer = z.object({
  data: z
    .object({ updateIssueComment: z.object({ issueComment: z.object({ id: z.string() }) }) })
    .nullable(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** Replaces the text of an earlier comment. A lost answer is found again by its text on the next read. */
export function updateComment(id: string, body: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: ["graphql", "-f", `query=${updateMutation}`, "-f", `id=${id}`, "-f", `body=${body}`],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<undefined, GithubEffectFailure> => {
    if (answer.status === "failed")
      return Err({
        reason: "github_failed",
        detail: `${answer.code}: ${answer.detail}`,
        next: effectRecovery,
      });
    if (answer.status === "uncertain")
      return Err({ reason: "github_uncertain", detail: answer.detail, next: effectRecovery });
    const parsed = updateAnswer.safeParse(answer.value.body);
    if (!parsed.success)
      return Err({
        reason: "github_uncertain",
        detail: "GitHub answered the comment update in an unknown form.",
        next: effectRecovery,
      });
    const errors = parsed.data.errors ?? [];
    if (errors.length > 0 || parsed.data.data === null)
      return Err({
        reason: "github_failed",
        detail:
          errors.map((error) => error.message).join(" ") || "GitHub kept the earlier comment.",
        next: effectRecovery,
      });
    return Ok(undefined);
  });
}

const readyMutation = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

/** A stack rewrite cannot leave a ready PR advertised with evidence for its old ancestry. */
export function markDraft(id: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: [
          "graphql",
          "-f",
          "query=mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
          "-f",
          `id=${id}`,
        ],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<void, GithubReadFailure> => {
    if (answer.status !== "succeeded")
      return Err({
        reason: "github_uncertain",
        detail: "The PR draft transition is unconfirmed. Inspect the PR before changing its head.",
        next: effectRecovery,
      });
    const parsed = z
      .object({
        data: z.object({
          convertPullRequestToDraft: z.object({
            pullRequest: z.object({ isDraft: z.literal(true) }),
          }),
        }),
      })
      .safeParse(answer.value.body);
    return parsed.success
      ? Ok(undefined)
      : Err({
          reason: "github_uncertain",
          detail: "GitHub did not confirm the PR as a draft.",
          next: effectRecovery,
        });
  });
}

const readyMutationAnswer = z.object({
  data: z
    .object({
      markPullRequestReadyForReview: z.object({
        pullRequest: z.object({ isDraft: z.boolean() }),
      }),
    })
    .nullable(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** Moves a draft PR to ready for review with GitHub's own mutation. */
export function markReady(id: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: ["graphql", "-f", `query=${readyMutation}`, "-f", `id=${id}`],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<undefined, GithubEffectFailure> => {
    if (answer.status === "failed")
      return Err({
        reason: "github_failed",
        detail: `${answer.code}: ${answer.detail}`,
        next: effectRecovery,
        state: { code: answer.code },
      });
    if (answer.status === "uncertain")
      return Err({
        reason: "github_uncertain",
        detail: answer.detail,
        next: effectRecovery,
        state: { requestStatus: answer.status },
      });
    const parsed = readyMutationAnswer.safeParse(answer.value.body);
    if (!parsed.success)
      return Err({
        reason: "github_uncertain",
        detail: "GitHub answered the ready mutation in an unknown form.",
        next: effectRecovery,
        state: { responseValid: false },
      });
    const errors = parsed.data.errors ?? [];
    const pr = parsed.data.data?.markPullRequestReadyForReview.pullRequest;
    if (errors.length > 0 || pr === undefined || pr.isDraft)
      return Err({
        reason: "github_failed",
        detail: errors.map((error) => error.message).join(" ") || "The PR stayed a draft.",
        next: effectRecovery,
        state: { readyConfirmed: false },
      });
    return Ok(undefined);
  });
}

const mergeQueueQuery = `query MergeQueueFacts($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id state headRefOid isMergeQueueEnabled mergeQueueEntry { id } }
  }
}`;
const mergeQueueAnswer = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        id: z.string(),
        state: z.enum(["OPEN", "MERGED", "CLOSED"]),
        headRefOid: z.string(),
        isMergeQueueEnabled: z.boolean(),
        mergeQueueEntry: z.object({ id: z.string() }).nullable(),
      }),
    }),
  }),
});

/** Queue policy and membership are observed independently of any earlier enqueue response. */
export function readMergeQueue(repository: string, number: number) {
  return query(
    ["-f", `query=${mergeQueueQuery}`, ...repositoryFields(repository), "-F", `number=${number}`],
    mergeQueueAnswer,
  ).map(({ data }) => ({
    id: data.repository.pullRequest.id,
    state: data.repository.pullRequest.state,
    head: data.repository.pullRequest.headRefOid,
    enabled: data.repository.pullRequest.isMergeQueueEnabled,
    entry: data.repository.pullRequest.mergeQueueEntry?.id ?? null,
  }));
}

const enqueueMutation = `mutation EnqueuePR($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { id } }
}`;
const enqueueAnswer = z.object({
  data: z
    .object({
      enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ id: z.string() }) }).nullable(),
    })
    .nullable(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        type: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});
type EnqueueFailure = ResultContext & {
  reason: "github_failed" | "github_uncertain" | "pr_enqueue_refused";
  detail: string;
};

function enqueueNotApplied(answer: z.infer<typeof enqueueAnswer>) {
  return (
    !answer.data?.enqueuePullRequest &&
    (answer.errors?.length ?? 0) > 0 &&
    answer.errors?.every(
      (error) =>
        ["UNPROCESSABLE", "FORBIDDEN", "NOT_FOUND"].includes(error.type ?? "") &&
        error.path?.length === 1 &&
        error.path[0] === "enqueuePullRequest",
    ) === true
  );
}

/** Pin the enqueue to the same head that passed the merge gate. The caller verifies membership. */
export function enqueuePullRequest(id: string, head: string) {
  return fromPromise(
    () =>
      GithubApi.call({
        args: ["graphql", "-f", `query=${enqueueMutation}`, "-f", `id=${id}`, "-f", `head=${head}`],
        timeoutMs: 60000,
      }),
    (cause, defect) => defect(cause),
  ).flatMap((answer): Result<undefined, EnqueueFailure> => {
    if (answer.status !== "succeeded")
      return Err({
        reason: answer.status === "failed" ? "github_failed" : "github_uncertain",
        detail: answer.detail,
        next: effectRecovery,
      });
    const parsed = enqueueAnswer.safeParse(answer.value.body);
    if (!parsed.success)
      return Err({
        reason: "github_uncertain",
        detail:
          "GitHub did not describe the enqueue response. Read queue membership before another request.",
        next: effectRecovery,
      });
    if (!parsed.data.data?.enqueuePullRequest || (parsed.data.errors?.length ?? 0) > 0)
      return Err({
        reason: "pr_enqueue_refused",
        detail:
          parsed.data.errors?.map((error) => error.message).join(" ") ??
          "GitHub refused the enqueue.",
        next: {
          decider: "person",
          question: "Which GitHub queue restriction must be resolved before this PR can enqueue?",
        },
        state: {
          notApplied: enqueueNotApplied(parsed.data),
        },
      });
    return Ok(undefined);
  });
}
