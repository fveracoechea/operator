import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { GithubApi } from "../github-api/main.ts";
import { answered, h2, prAnswer, target } from "./home-fixture.ts";
import {
  postReview,
  readPullRequest,
  replyToThread,
  unresolveThread,
  type PostOutcome,
  type ThreadOutcome,
} from "./github.ts";

afterEach(() => {
  mock.restore();
});

type Outcome = Awaited<ReturnType<typeof GithubApi.call>>;
const failed: Outcome = { status: "failed", code: "HTTP 403", detail: "No.", httpStatus: 403 };
const lost: Outcome = { status: "uncertain", detail: "Timed out." };

function github(outcome: Outcome | Error) {
  return spyOn(GithubApi, "call").mockImplementation(async () => {
    if (outcome instanceof Error) return Promise.reject(outcome);
    return outcome;
  });
}

test("a PR read asks GitHub once for the PR facts by owner, name, and number", async () => {
  const call = github(answered(prAnswer()));
  expect(await readPullRequest(target)).toMatchObject({
    tag: "Ok",
    value: { state: "OPEN", head: h2, author: "author", viewer: "me", files: ["feature.ts"] },
  });
  expect(call).toHaveBeenCalledTimes(1);
  const request = call.mock.calls[0]?.[0];
  expect(request?.timeoutMs).toBe(60000);
  expect(request?.args.slice(0, 2)).toEqual(["graphql", "-f"]);
  expect(request?.args[2]?.startsWith("query=query($owner: String!")).toBe(true);
  expect(request?.args[2]?.includes("reviewThreads(first: 100)")).toBe(true);
  expect(request?.args.slice(3)).toEqual([
    "-f",
    "owner=example",
    "-f",
    "name=one",
    "-F",
    "number=7",
  ]);
  await readPullRequest({ repository: "solo", number: 3, url: "u" });
  expect(call.mock.calls[1]?.[0].args.slice(3)).toEqual([
    "-f",
    "owner=solo",
    "-f",
    "name=",
    "-F",
    "number=3",
  ]);
});

test("a PR read names a refusal, a lost answer, an unknown answer, and a missing PR", async () => {
  github(failed);
  expect(await readPullRequest(target)).toMatchObject({
    tag: "Err",
    error: { reason: "github_failed", detail: "HTTP 403: No." },
  });
  mock.restore();
  github(lost);
  expect(await readPullRequest(target)).toMatchObject({
    tag: "Err",
    error: { reason: "github_uncertain", detail: "Timed out." },
  });
  const invalid = {
    reason: "github_invalid_response",
    detail: "GitHub did not describe PR #7 of example/one in the expected form.",
  };
  for (const body of [
    {},
    { data: { viewer: { login: "me" }, repository: { pullRequest: null } } },
  ]) {
    mock.restore();
    github(answered(body));
    expect(await readPullRequest(target)).toMatchObject({ tag: "Err", error: invalid });
  }
  mock.restore();
  github(new Error("spawn failed"));
  expect((await readPullRequest(target)).tag).toBe("Defect");
});

const review = { commit: h2, event: "COMMENT", body: "Body.", comments: [] };

test("a post sends one review with its inline comments on the right side", async () => {
  const call = github(answered({ node_id: "N", html_url: "https://r", state: "APPROVED" }));
  expect(
    await postReview(target, {
      ...review,
      comments: [{ path: "a.ts", line: 3, body: "Fix." }],
    }),
  ).toMatchObject({
    tag: "Ok",
    value: { status: "posted", review: { id: "N", url: "https://r", event: "APPROVE" } },
  });
  const request = call.mock.calls[0]?.[0];
  expect(request?.args).toEqual([
    "repos/example/one/pulls/7/reviews",
    "--method",
    "POST",
    "--input",
    "-",
  ]);
  expect(request?.timeoutMs).toBe(60000);
  expect(JSON.parse(request?.input ?? "null")).toEqual({
    commit_id: h2,
    event: "COMMENT",
    body: "Body.",
    comments: [{ path: "a.ts", line: 3, body: "Fix.", side: "RIGHT" }],
  });
  await postReview(target, review);
  expect(JSON.parse(call.mock.calls[1]?.[0].input ?? "null")).toEqual({
    commit_id: h2,
    event: "COMMENT",
    body: "Body.",
  });
});

test("a post is failed for a refusal and uncertain for a lost or unknown answer", async () => {
  const cases: [Outcome, PostOutcome][] = [
    [failed, { status: "failed", detail: "HTTP 403: No." }],
    [lost, { status: "uncertain", detail: "Timed out." }],
    [
      answered({ id: 1 }),
      { status: "uncertain", detail: "GitHub answered the post in an unknown form." },
    ],
  ];
  for (const [outcome, expected] of cases) {
    mock.restore();
    github(outcome);
    const result = await postReview(target, review);
    expect(result.tag === "Ok" ? result.value : null).toEqual(expected);
  }
  mock.restore();
  github(new Error("spawn failed"));
  expect((await postReview(target, review)).tag).toBe("Defect");
});

test("a reply sends one GraphQL write for its thread", async () => {
  const call = github(
    answered({ data: { addPullRequestReviewThreadReply: { comment: { id: "c" } } } }),
  );
  expect(await replyToThread("T1", "Body.")).toMatchObject({
    tag: "Ok",
    value: { status: "done" },
  });
  const reply = call.mock.calls[0]?.[0];
  expect(reply?.timeoutMs).toBe(60000);
  expect(reply?.args.slice(0, 2)).toEqual(["graphql", "-f"]);
  expect(reply?.args[2]?.startsWith("query=mutation($thread: ID!, $body: String!)")).toBe(true);
  expect(reply?.args[2]?.includes("addPullRequestReviewThreadReply(input:")).toBe(true);
  expect(reply?.args.slice(3)).toEqual(["-f", "thread=T1", "-f", "body=Body."]);
});

test("an unresolve sends one GraphQL write for its thread", async () => {
  const second = github(
    answered({ data: { unresolveReviewThread: { thread: { isResolved: false } } }, errors: [] }),
  );
  expect(await unresolveThread("T2")).toMatchObject({ tag: "Ok", value: { status: "done" } });
  const unresolve = second.mock.calls[0]?.[0];
  expect(unresolve?.args[2]?.startsWith("query=mutation($thread: ID!)")).toBe(true);
  expect(unresolve?.args[2]?.includes("unresolveReviewThread(input:")).toBe(true);
  expect(unresolve?.args.slice(3)).toEqual(["-f", "thread=T2"]);
  expect(unresolve?.args.slice(0, 2)).toEqual(["graphql", "-f"]);
});

test("a thread write names a refusal, a lost answer, an unknown answer, and an unconfirmed write", async () => {
  const notConfirmed: ThreadOutcome = {
    status: "uncertain",
    detail: "GitHub did not confirm the thread write.",
  };
  const cases: [() => ReturnType<typeof replyToThread>, Outcome, ThreadOutcome][] = [
    [() => replyToThread("T", "b"), failed, { status: "failed", detail: "HTTP 403: No." }],
    [() => unresolveThread("T"), lost, { status: "uncertain", detail: "Timed out." }],
    [
      () => replyToThread("T", "b"),
      answered({ data: 1 }),
      { status: "uncertain", detail: "GitHub answered a thread write in an unknown form." },
    ],
    [
      () => unresolveThread("T"),
      answered({ errors: [{ message: "Locked." }, { message: "Later." }] }),
      { status: "failed", detail: "Locked. Later." },
    ],
    [() => replyToThread("T", "b"), answered({ data: {} }), notConfirmed],
    [
      () => replyToThread("T", "b"),
      answered({ data: { addPullRequestReviewThreadReply: {} } }),
      { status: "uncertain", detail: "GitHub answered a thread write in an unknown form." },
    ],
    [
      () => replyToThread("T", "b"),
      answered({ data: { addPullRequestReviewThreadReply: { comment: {} } } }),
      { status: "uncertain", detail: "GitHub answered a thread write in an unknown form." },
    ],
    [() => replyToThread("T", "b"), answered({ data: null }), notConfirmed],
    [() => unresolveThread("T"), answered({ data: {} }), notConfirmed],
    [() => unresolveThread("T"), answered({ data: null }), notConfirmed],
    [
      () => unresolveThread("T"),
      answered({ data: { unresolveReviewThread: { thread: { isResolved: true } } } }),
      notConfirmed,
    ],
  ];
  for (const [write, outcome, expected] of cases) {
    mock.restore();
    github(outcome);
    const result = await write();
    expect(result.tag === "Ok" ? result.value : null).toEqual(expected);
  }
  mock.restore();
  github(new Error("spawn failed"));
  expect((await replyToThread("T", "b")).tag).toBe("Defect");
});
