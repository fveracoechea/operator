/**
 * A controlled `gh` executable for public CLI tests. It answers `gh auth status`, the GraphQL
 * reads of the PR feedback loop and the relay, the merge request, the PR base change, remote
 * branch reads and deletions, and the review read and post from one JSON file, and logs each call. Each full PR read first
 * applies the next queued change, so a test can script what later polls observe. A `parentQueue`
 * scripts the parent reads the same way. With a `remote` bare repository, a PR without a scripted
 * `head` reports its branch head there. `mergeLost` applies a merge and then answers 502, and
 * `deleteLost` answers 502 without deleting. `postHold` writes `post-held` after a review post is
 * recorded, then holds the answer until the test writes `post-release` or removes its root.
 * It is not evidence of the live GitHub integration.
 */
export function fakeGithubScript(root: string) {
  return `#!${process.execPath}
const root = ${JSON.stringify(root)};
const stateFile = root + "/github.json";
const args = process.argv.slice(2);
const log = root + "/gh-calls.jsonl";
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : "") + JSON.stringify(args) + "\\n");
if (args[0] === "auth") process.exit(0);
const state = await Bun.file(stateFile).exists() ? await Bun.file(stateFile).json() : {};
state.pulls ??= []; state.queue ??= [];
const field = (name) => { const entry = args.find((arg, index) => ["-f", "-F"].includes(args[index - 1]) && arg.startsWith(name + "=")); return entry?.slice(name.length + 1); };
const answer = (body) => { console.log("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(body)); };
if (state.fail) { console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: state.fail })); process.exit(1); }
const status = (code, text, body) => { console.log("HTTP/2.0 " + code + " " + text + "\\r\\nContent-Type: application/json\\r\\n\\r\\n" + (body === undefined ? "" : JSON.stringify(body))); };
const method = args[args.indexOf("-X") + 1];
const path = args.find((arg) => arg.startsWith("repos/"));
state.branches ??= {};
if (path?.includes("/pulls/") && method === "PUT") {
  const pr = state.pulls.find((row) => path.endsWith("/pulls/" + row.number + "/merge"));
  if (state.mergeRefuse || pr?.state !== "OPEN") status(405, "Method Not Allowed", { message: "Pull Request is not mergeable" });
  else if (field("sha") !== (pr.head ?? "head-1")) status(409, "Conflict", { message: "Head branch was modified." });
  else {
    pr.state = "MERGED"; pr.mergeCommit = "merge-" + (pr.head ?? "head-1"); pr.mergeMethod = field("merge_method");
    if (state.mergeLost) status(502, "Bad Gateway", { message: "upstream fault" });
    else status(200, "OK", { merged: true, sha: pr.mergeCommit });
  }
  await Bun.write(stateFile, JSON.stringify(state));
  process.exit(0);
}
if (path?.includes("/git/ref")) {
  const branch = path.split("/heads/")[1];
  if (method === "DELETE") {
    if (state.deleteLost) status(502, "Bad Gateway", { message: "upstream fault" });
    else if (state.branches[branch] === undefined) status(422, "Unprocessable Entity", { message: "Reference does not exist" });
    else { delete state.branches[branch]; status(204, "No Content"); }
  } else if (state.branches[branch] === undefined) status(404, "Not Found", { message: "Not Found" });
  else status(200, "OK", { ref: "refs/heads/" + branch, object: { sha: state.branches[branch] } });
  await Bun.write(stateFile, JSON.stringify(state));
  process.exit(0);
}
const query = field("query") ?? "";
const nodes = (items) => ({ totalCount: items.length, nodes: items });
const author = (login) => (login === null ? null : { login });
const reviewsPath = args.find((arg) => arg.startsWith("repos/") && arg.endsWith("/reviews"));
const check = (item) => item.status ? { __typename: "StatusContext", context: item.name, state: item.status, targetUrl: null, isRequired: item.required ?? false } : { __typename: "CheckRun", name: item.name, status: item.conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion: item.conclusion ?? null, detailsUrl: "https://ci/" + item.name, isRequired: item.required ?? false };
if (reviewsPath) {
  // The review post reads its payload from standard input, as gh api --input - does.
  const payload = JSON.parse(await Bun.stdin.text());
  const pr = state.pulls.find((row) => row.number === Number(reviewsPath.split("/")[4]));
  state.posted ??= [];
  if (state.postFail) { await Bun.write(stateFile, JSON.stringify(state)); console.log("HTTP/2.0 422 Unprocessable Entity\\r\\n\\r\\n" + JSON.stringify({ message: state.postFail })); process.exit(1); }
  const id = "review-" + (state.posted.length + 1);
  state.posted.push({ id, number: pr.number, ...payload });
  pr.reviews = [...(pr.reviews ?? []), { id, state: payload.event, body: payload.body, author: state.viewer ?? "owner" }];
  await Bun.write(stateFile, JSON.stringify(state));
  if (state.postUncertain) { state.postUncertain = false; await Bun.write(stateFile, JSON.stringify(state)); console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: "lost" })); process.exit(1); }
  // A failed test removes its root, which also ends the hold.
  if (state.postHold) { await Bun.write(root + "/post-held", ""); while (!(await Bun.file(root + "/post-release").exists()) && (await Bun.file(stateFile).exists())) await Bun.sleep(20); }
  answer({ node_id: id, html_url: "https://github.com/r/" + id, state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[payload.event], commit_id: payload.commit_id });
  process.exit(0);
}
if (query.includes("addPullRequestReviewThreadReply") || query.includes("unresolveReviewThread")) {
  // Thread writes: a reply appends a comment, and an unresolve reopens the thread.
  const thread = state.pulls.flatMap((row) => row.threads ?? []).find((row) => row.id === field("thread"));
  (state.threadCalls ??= []).push({ kind: query.includes("unresolve") ? "unresolve" : "reply", thread: field("thread"), body: field("body") });
  if (state.threadFail || !thread) { await Bun.write(stateFile, JSON.stringify(state)); answer({ data: null, errors: [{ message: state.threadFail ?? "Could not resolve to a node." }] }); process.exit(0); }
  if (query.includes("unresolve")) thread.resolved = false;
  else thread.comments.push({ id: "reply-" + state.threadCalls.length, author: state.viewer ?? "owner", body: field("body"), createdAt: new Date().toISOString() });
  await Bun.write(stateFile, JSON.stringify(state));
  if (state.threadLost) { state.threadLost = false; await Bun.write(stateFile, JSON.stringify(state)); console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: "lost" })); process.exit(1); }
  answer(query.includes("unresolve") ? { data: { unresolveReviewThread: { thread: { id: thread.id, isResolved: false } } } } : { data: { addPullRequestReviewThreadReply: { comment: { id: "reply-" + state.threadCalls.length } } } });
  process.exit(0);
}
if (query.includes("files(first")) {
  // A delay holds two concurrent waits between their state read and their write.
  if (state.reviewReadDelayMs) await Bun.sleep(state.reviewReadDelayMs);
  // Each review read first applies the next queued change, so a test scripts what waits observe.
  const change = (state.reviewQueue ??= []).shift();
  if (change) { const index = state.pulls.findIndex((row) => row.number === Number(field("number"))); state.pulls[index] = { ...state.pulls[index], ...change }; await Bun.write(stateFile, JSON.stringify(state)); }
  const pr = state.pulls.find((row) => row.number === Number(field("number")));
  answer({ data: { viewer: { login: state.viewer ?? "owner" }, repository: { pullRequest: pr === undefined ? null : {
    state: pr.state, headRefOid: pr.head ?? "head-1", author: author(pr.author ?? "author"),
    files: { totalCount: pr.totalFiles ?? (pr.files ?? []).length, nodes: (pr.files ?? []).map((path) => ({ path })) },
    reviewThreads: nodes((pr.threads ?? []).map((thread) => ({ id: thread.id, isResolved: thread.resolved ?? false, resolvedBy: thread.resolved ? author(thread.resolvedBy ?? "author") : null, starter: nodes(thread.comments.slice(0, 1).map((comment) => ({ author: author(comment.author ?? "reviewer") }))), comments: nodes(thread.comments.map((comment) => ({ id: comment.id, body: comment.body ?? "", createdAt: comment.createdAt ?? "2000-01-01T00:00:00Z", author: author(comment.author ?? "reviewer") }))) }))),
    reviews: nodes((pr.reviews ?? []).map((review) => ({ id: review.id, url: "https://github.com/r/" + review.id, body: review.body ?? "", state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[review.state] ?? review.state ?? "COMMENTED", author: author(review.author ?? "reviewer") }))),
    comments: nodes((pr.comments ?? []).map((comment) => ({ id: comment.id, body: comment.body ?? "", createdAt: comment.createdAt ?? "2000-01-01T00:00:00Z", author: author(comment.author ?? "reviewer") }))),
    timelineItems: nodes((pr.reviewRequests ?? []).map((request) => ({ createdAt: request.createdAt, requestedReviewer: { login: request.reviewer } }))),
    commits: nodes([{ commit: { statusCheckRollup: (pr.checks ?? []).length === 0 ? null : { contexts: { ...nodes(pr.checks.map(check)), totalCount: pr.totalChecks ?? pr.checks.length } } } }]),
  } } } });
  process.exit(0);
}
// With a real bare remote, an open PR's head is its branch there, as GitHub reports a push.
const headOf = (pr) => pr.head ?? (state.remote ? Bun.spawnSync(["git", "--git-dir", state.remote, "rev-parse", "refs/heads/" + pr.headRefName]).stdout.toString().trim() : "head-1");
if (args.includes("PATCH")) {
  if (state.failPatch) { console.log("HTTP/2.0 422 Unprocessable Entity\\r\\n\\r\\n" + JSON.stringify({ message: state.failPatch })); process.exit(1); }
  const number = Number(args.find((arg) => arg.startsWith("repos/")).split("/").at(-1));
  const pr = state.pulls.find((row) => row.number === number);
  pr.baseRefName = field("base");
  await Bun.write(stateFile, JSON.stringify(state));
  answer({ number, base: { ref: pr.baseRefName } });
} else if (query.includes("pullRequests(")) {
  const branch = field("branch");
  answer({ data: { repository: { defaultBranchRef: { name: state.defaultBranch ?? "main" }, pullRequests: nodes(state.pulls.filter((pr) => pr.headRefName === branch && pr.state === "OPEN").map((pr) => ({ number: pr.number, url: pr.url, baseRefName: pr.baseRefName ?? "main", headRefName: pr.headRefName, headRepository: { nameWithOwner: pr.headRepository } }))) } } });
} else if (query.includes("RelayParent")) {
  const number = Number(field("number"));
  const index = state.pulls.findIndex((pr) => pr.number === number);
  const change = (state.parentQueue ??= []).shift();
  if (change) state.pulls[index] = { ...state.pulls[index], ...change };
  await Bun.write(stateFile, JSON.stringify(state));
  const pr = state.pulls[index];
  answer({ data: { repository: { pullRequest: { state: pr.state, baseRefName: pr.baseRefName ?? "main", headRefOid: headOf(pr) } } } });
} else {
  const number = Number(field("number"));
  const index = state.pulls.findIndex((pr) => pr.number === number);
  const change = state.queue.shift();
  if (change) state.pulls[index] = { ...state.pulls[index], ...change };
  await Bun.write(stateFile, JSON.stringify(state));
  const pr = state.pulls[index];
  answer({ data: { viewer: { login: state.viewer ?? "owner" }, repository: { defaultBranchRef: { name: state.defaultBranch ?? "main" }, viewerDefaultMergeMethod: state.mergeMethod ?? "SQUASH", pullRequest: {
    state: pr.state, baseRefName: pr.baseRefName ?? "main", headRefName: pr.headRefName, headRefOid: headOf(pr), reviewDecision: pr.reviewDecision ?? null, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    reviews: nodes((pr.reviews ?? []).map((review) => ({ id: review.id, state: review.state, body: review.body ?? "", url: "https://github.com/r/" + review.id, author: author(review.author ?? "reviewer") }))),
    comments: nodes((pr.comments ?? []).map((comment) => ({ id: comment.id, body: comment.body, url: "https://github.com/c/" + comment.id, author: author(comment.author ?? "reviewer") }))),
    reviewThreads: nodes((pr.threads ?? []).map((thread) => ({ isResolved: thread.resolved ?? false, path: thread.path ?? "file.ts", comments: nodes(thread.comments.map((comment) => ({ id: comment.id, body: comment.body, url: "https://github.com/t/" + comment.id, author: author(comment.author ?? "reviewer") }))) }))),
    commits: nodes([{ commit: { statusCheckRollup: (pr.checks ?? []).length === 0 ? null : { contexts: nodes(pr.checks.map((check) => check.status ? { __typename: "StatusContext", context: check.name, state: check.status, targetUrl: null } : { __typename: "CheckRun", name: check.name, status: check.conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion: check.conclusion ?? null, detailsUrl: "https://ci/" + check.name })) } } }]),
  } } } });
}
`;
}
