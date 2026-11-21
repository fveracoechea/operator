/**
 * A controlled `gh` executable for public CLI tests. It answers `gh auth status`, the GraphQL
 * reads of the PR feedback loop and the relay, the synchronous and background merge requests,
 * the PR base change, remote branch reads and deletions, and the review read and post from one
 * JSON file, and logs each call. Each full PR read first applies the next queued change, so a
 * test can script what later polls observe. A `parentQueue` scripts the parent reads the same
 * way. With a `remote` bare repository, a PR without a scripted `head` reports its branch head
 * there. A PR with `stacked` refuses the synchronous merge with GitHub's 403. A background merge
 * request stays pending for `mergePending` reads, then merges the PR at its pinned head or fails.
 * `mergeLost` applies a merge and then answers 502, and `deleteLost` answers 502 without
 * deleting. `postHold` writes `post-held` after a review post is recorded, then holds the answer
 * until the test writes `post-release` or removes its root. The summary comment post, its update,
 * and the ready mutation record `commented`, `updated`, and `readied`, and `commentLost` and
 * `readyLost` apply the effect once and then answer 502. `cleanupHold` holds each remote branch
 * read and deletion the same way, with `cleanup-held` and `cleanup-release`.
 * `reviewReadBarrier` holds each review read until that many review reads have arrived under the
 * barrier since the root was created.
 * It is not evidence of the live GitHub integration.
 */
export function fakeGithubScript(root: string, options: { mergeReadRace?: boolean } = {}) {
  return `#!${process.execPath}
import { writeFile } from ${JSON.stringify(Bun.fileURLToPath(new URL("../../lib/write-file.ts", import.meta.url)))};
const root = ${JSON.stringify(root)};
const stateFile = root + "/github.json";
const args = process.argv.slice(2);
// Select a reachable stale-read schedule without changing any fake response or merge rule.
const race = ${options.mergeReadRace === true};
const { appendFileSync, existsSync, mkdirSync, watch } = await import("node:fs");
const observation = args.some(arg => arg.startsWith("query=") && arg.includes("reviewDecision"));
const mergePut = args.includes("PUT") && args.some(arg => arg.endsWith("/merge-async"));
const trace = (event, snapshot) => {
  if (race) appendFileSync(root + "/merge-race-" + process.pid + ".jsonl", JSON.stringify({ event, state: snapshot.pulls?.[0]?.state }) + "\\n");
};
const waitFor = async (name) => {
  const file = root + "/" + name;
  if (existsSync(file)) return;
  await new Promise(resolve => {
    const watcher = watch(root, () => { if (existsSync(file)) { watcher.close(); resolve(); } });
    if (existsSync(file)) { watcher.close(); resolve(); }
  });
};
if (race && existsSync(root + "/merge-race-saved")) {
  if (mergePut) await waitFor("merge-race-verified");
  else if (observation) await waitFor("merge-race-stale-finished");
}
const log = root + "/gh-calls.jsonl";
await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : "") + JSON.stringify(args) + "\\n");
if (args[0] === "auth") process.exit(0);
const state = await Bun.file(stateFile).exists() ? await Bun.file(stateFile).json() : {};
let staleReader = false;
if (race && observation) {
  try { mkdirSync(root + "/merge-race-reader"); staleReader = true; }
  catch (cause) { if (cause.code !== "EEXIST") throw cause; }
  trace("read", state);
  if (staleReader) { trace("held", state); await waitFor("merge-race-saved"); }
}
// Publish a whole fixture snapshot so concurrent commands never parse a truncated JSON file.
const save = () => writeFile(stateFile, new TextEncoder().encode(JSON.stringify(state)));
state.pulls ??= []; state.queue ??= [];
const field = (name) => { const entry = args.find((arg, index) => ["-f", "-F"].includes(args[index - 1]) && arg.startsWith(name + "=")); return entry?.slice(name.length + 1); };
const answer = (body) => { console.log("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(state.graphqlErrors && args.includes("graphql") ? { ...body, errors: [{ message: "Partial read refused" }] } : body)); };
if (state.fail) { console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: state.fail })); process.exit(1); }
const status = (code, text, body) => { console.log("HTTP/2.0 " + code + " " + text + "\\r\\nContent-Type: application/json\\r\\n\\r\\n" + (body === undefined ? "" : JSON.stringify(body))); };
const method = args[args.indexOf("-X") + 1];
const path = args.find((arg) => arg.startsWith("repos/"));
if (args.includes("user")) { answer({ login: state.viewer ?? "owner" }); process.exit(0); }
if (path && (path.includes("/pulls?") || /\\/pulls\\/\\d+$/.test(path)) && !args.includes("PUT") && !args.includes("PATCH")) {
  const rest = (pr) => ({ number: pr.number, html_url: "https://github.com/example/one/pull/" + pr.number, state: pr.state.toLowerCase(), draft: pr.isDraft ?? false, user: { login: pr.author ?? state.viewer ?? "owner" }, base: { ref: pr.baseRefName ?? "main", repo: { default_branch: state.defaultBranch ?? "main" } }, head: { ref: pr.headRefName, sha: pr.head ?? (state.remote ? Bun.spawnSync(["git", "--git-dir", state.remote, "rev-parse", "refs/heads/" + pr.headRefName]).stdout.toString().trim() : "head-1"), repo: pr.headRepository === null ? null : { full_name: pr.headRepository ?? "example/one" } } });
  if (path.includes("?")) {
    const head = new URLSearchParams(path.split("?")[1]).get("head").split(":").slice(1).join(":");
    answer(state.pulls.filter(pr => pr.state === "OPEN" && pr.headRefName === head).map(rest));
  } else {
    const pr = state.pulls.find(pr => path.endsWith("/pulls/" + pr.number));
    if (pr) answer(rest(pr)); else status(404, "Not Found", { message: "Not Found" });
  }
  process.exit(0);
}
state.branches ??= {};
if (path?.includes("/merge-async")) {
  // A background merge: the submit answers pending, and each read runs the next step.
  state.mergeRequests ??= [];
  const merged = (pr) => ({ status: "merged", details: { message: "Pull request was merged.", sha: pr.mergeCommit } });
  if (method === "PUT") {
    const pr = state.pulls.find((row) => path.endsWith("/pulls/" + row.number + "/merge-async"));
    if (pr?.state === "MERGED") status(200, "OK", merged(pr));
    else if (state.mergeRefuse || pr?.state !== "OPEN") status(422, "Unprocessable Entity", { message: "Pull Request is not mergeable" });
    else if (state.mergeLost) {
      pr.state = "MERGED"; pr.mergeCommit = "merge-" + (pr.head ?? "head-1");
      status(502, "Bad Gateway", { message: "upstream fault" });
    } else {
      const uuid = "request-" + (state.mergeRequests.length + 1);
      state.mergeRequests.push({ uuid, number: pr.number, sha: field("sha"), method: field("merge_method"), action: field("merge_action"), pending: state.mergePending ?? 0 });
      if (state.mergeSubmitLost) status(502, "Bad Gateway", { message: "accepted request response lost" });
      else status(202, "Accepted", { status: "pending", details: { message: "Merge request enqueued.", uuid } });
    }
  } else {
    const request = state.mergeRequests.find((row) => path.endsWith("/merge-async/" + row.uuid));
    const pr = state.pulls.find((row) => row.number === request.number);
     if (state.mergeReadLost) status(502, "Bad Gateway", { message: "request read unavailable" });
     else if (request.pending > 0) { request.pending -= 1; status(200, "OK", { status: "pending", details: { message: "Merge request enqueued.", uuid: request.uuid } }); }
    else if (pr.state === "MERGED") status(200, "OK", merged(pr));
    else if (request.sha !== (pr.head ?? "head-1")) status(200, "OK", { status: "failed", details: { message: "Head branch was modified." } });
    else {
      pr.state = "MERGED"; pr.mergeCommit = "merge-" + (pr.head ?? "head-1"); pr.mergeMethod = request.method;
      status(200, "OK", merged(pr));
    }
  }
  await save();
  if (race && mergePut && !existsSync(root + "/merge-race-saved")) {
    trace("merged", state);
    await Bun.write(root + "/merge-race-saved", "");
  }
  process.exit(0);
}
if (path?.includes("/pulls/") && method === "PUT") {
  const pr = state.pulls.find((row) => path.endsWith("/pulls/" + row.number + "/merge"));
  // GitHub refuses the synchronous merge of a PR that it treats as stacked.
  if (pr?.stacked) status(403, "Forbidden", { message: "Merging stacked PRs via this endpoint is not supported. Use the asynchronous merge endpoint instead." });
  else if (state.mergeRefuse || pr?.state !== "OPEN") status(405, "Method Not Allowed", { message: "Pull Request is not mergeable" });
  else if (field("sha") !== (pr.head ?? "head-1")) status(409, "Conflict", { message: "Head branch was modified." });
  else {
    pr.state = "MERGED"; pr.mergeCommit = "merge-" + (pr.head ?? "head-1"); pr.mergeMethod = field("merge_method");
    if (state.mergeLost) status(502, "Bad Gateway", { message: "upstream fault" });
    else status(200, "OK", { merged: true, sha: pr.mergeCommit });
  }
  await save();
  process.exit(0);
}
if (path?.includes("/git/ref")) {
  // A failed test removes its root, which also ends the hold.
  if (state.cleanupHold) { await Bun.write(root + "/cleanup-held", ""); while (!(await Bun.file(root + "/cleanup-release").exists()) && (await Bun.file(stateFile).exists())) await Bun.sleep(20); }
  const branch = path.split("/heads/")[1];
  if (method === "DELETE") {
    if (state.deleteLost) status(502, "Bad Gateway", { message: "upstream fault" });
    else if (state.branches[branch] === undefined) status(422, "Unprocessable Entity", { message: "Reference does not exist" });
    else { delete state.branches[branch]; status(204, "No Content"); }
  } else if (state.branches[branch] === undefined) status(404, "Not Found", { message: "Not Found" });
  else status(200, "OK", { ref: "refs/heads/" + branch, object: { sha: state.branches[branch] } });
  await save();
  process.exit(0);
}
const query = field("query") ?? "";
const nodes = (items) => ({ totalCount: items.length, nodes: items });
const author = (login) => (login === null ? null : { login });
const reviewsPath = args.find((arg) => arg.startsWith("repos/") && arg.endsWith("/reviews"));
const check = (item) => item.status ? { __typename: "StatusContext", id: item.id, createdAt: item.createdAt, context: item.name, state: item.status, targetUrl: null, isRequired: item.required ?? false } : { __typename: "CheckRun", id: item.id, startedAt: item.startedAt, completedAt: item.completedAt, name: item.name, status: item.conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion: item.conclusion ?? null, detailsUrl: "https://ci/" + item.name, isRequired: item.required ?? false };
if (reviewsPath) {
  // The review post reads its payload from standard input, as gh api --input - does.
  const payload = JSON.parse(await Bun.stdin.text());
  const pr = state.pulls.find((row) => row.number === Number(reviewsPath.split("/")[4]));
  state.posted ??= [];
  if (state.postFail) { await save(); console.log("HTTP/2.0 422 Unprocessable Entity\\r\\n\\r\\n" + JSON.stringify({ message: state.postFail })); process.exit(1); }
  const id = "review-" + (state.posted.length + 1);
  state.posted.push({ id, number: pr.number, ...payload });
  pr.reviews = [...(pr.reviews ?? []), { id, state: payload.event, body: payload.body, author: state.viewer ?? "owner" }];
  await save();
  if (state.postUncertain) { state.postUncertain = false; await save(); console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: "lost" })); process.exit(1); }
  // A failed test removes its root, which also ends the hold.
  if (state.postHold) { await Bun.write(root + "/post-held", ""); while (!(await Bun.file(root + "/post-release").exists()) && (await Bun.file(stateFile).exists())) await Bun.sleep(20); }
  answer({ node_id: id, html_url: "https://github.com/r/" + id, state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[payload.event], commit_id: payload.commit_id });
  process.exit(0);
}
const commentsPath = args.find((arg) => arg.startsWith("repos/") && arg.endsWith("/comments"));
if (commentsPath) {
  // The summary comment reads its payload from standard input, as gh api --input - does.
  const payload = JSON.parse(await Bun.stdin.text());
  const pr = state.pulls.find((row) => row.number === Number(commentsPath.split("/")[4]));
  state.commented ??= [];
  const id = "comment-" + (state.commented.length + 1);
  state.commented.push({ id, number: pr.number, body: payload.body });
  pr.comments = [...(pr.comments ?? []), { id, body: payload.body, author: state.viewer ?? "owner" }];
  await save();
  if (state.commentLost) { state.commentLost = false; await save(); console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: "lost" })); process.exit(1); }
  answer({ node_id: id, html_url: "https://github.com/c/" + id });
  process.exit(0);
}
if (query.includes("addPullRequestReviewThreadReply") || query.includes("unresolveReviewThread")) {
  // Thread writes: a reply appends a comment, and an unresolve reopens the thread.
  const thread = state.pulls.flatMap((row) => row.threads ?? []).find((row) => row.id === field("thread"));
  (state.threadCalls ??= []).push({ kind: query.includes("unresolve") ? "unresolve" : "reply", thread: field("thread"), body: field("body") });
  if (state.threadFail || !thread) { await save(); answer({ data: null, errors: [{ message: state.threadFail ?? "Could not resolve to a node." }] }); process.exit(0); }
  if (query.includes("unresolve")) thread.resolved = false;
  else thread.comments.push({ id: "reply-" + state.threadCalls.length, author: state.viewer ?? "owner", body: field("body"), createdAt: new Date().toISOString() });
  await save();
  if (state.threadLost) { state.threadLost = false; await save(); console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: "lost" })); process.exit(1); }
  answer(query.includes("unresolve") ? { data: { unresolveReviewThread: { thread: { id: thread.id, isResolved: false } } } } : { data: { addPullRequestReviewThreadReply: { comment: { id: "reply-" + state.threadCalls.length } } } });
  process.exit(0);
}
if (query.includes("files(first")) {
  // A barrier holds each review read until that many reads have arrived, so concurrent waits all
  // read their request before any of them writes. A failed test removes its root, which also ends it.
  if (state.reviewReadBarrier) {
    const readers = root + "/review-readers";
    await Bun.write(readers + "/" + crypto.randomUUID(), "");
    while ((await Array.fromAsync(new Bun.Glob("*").scan(readers))).length < state.reviewReadBarrier && (await Bun.file(stateFile).exists())) await Bun.sleep(20);
  }
  // Each review read first applies the next queued change, so a test scripts what waits observe.
  const change = (state.reviewQueue ??= []).shift();
  if (change) { const index = state.pulls.findIndex((row) => row.number === Number(field("number"))); state.pulls[index] = { ...state.pulls[index], ...change }; await save(); }
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
if (query.includes("MergeQueueFacts")) {
  if (state.queueMembershipReads?.length) {
    const entry = state.queueMembershipReads.shift();
    await save();
    if (entry === "lost") {
      status(502, "Bad Gateway", { message: "Later membership response lost." });
      process.exit(1);
    }
    const pr = state.pulls.find(row => row.number === Number(field("number")));
    answer({ data: { repository: { pullRequest: { id: "PR_" + pr.number, state: pr.state, headRefOid: headOf(pr), isMergeQueueEnabled: true, mergeQueueEntry: entry === null ? null : { id: entry } } } } });
    process.exit(0);
  }
  if (state.enqueueTypedRefused && state.enqueueVerificationLost) {
    state.enqueueVerificationLost = false;
    await save();
    status(502, "Bad Gateway", { message: "Membership verification response lost." });
    process.exit(1);
  }
  const pr = state.pulls.find(row => row.number === Number(field("number")));
  answer({ data: { repository: { pullRequest: { id: "PR_" + pr.number, state: pr.state, headRefOid: headOf(pr), isMergeQueueEnabled: pr.isMergeQueueEnabled ?? false, mergeQueueEntry: pr.queueEntry ? { id: pr.queueEntry } : null } } } });
  process.exit(0);
}
if (query.includes("mutation EnqueuePR")) {
  if (state.enqueueTypedRefuse) {
    state.enqueueTypedRefused = true;
    await save();
    answer({ data: { enqueuePullRequest: null }, errors: [{ type: "UNPROCESSABLE", path: ["enqueuePullRequest"], message: "Queue admission refused." }] });
    process.exit(0);
  }
  const pr = state.pulls.find(row => "PR_" + row.number === field("id"));
  if (state.enqueueRefuse || field("head") !== headOf(pr)) { answer({ data: null, errors: [{ message: "Queue refused the head." }] }); process.exit(0); }
  pr.queueEntry = "QUEUE_" + pr.number;
  await save();
  if (state.enqueueLost) { state.enqueueLost = false; await save(); status(502, "Bad Gateway", { message: "lost" }); process.exit(1); }
  answer({ data: { enqueuePullRequest: { mergeQueueEntry: { id: pr.queueEntry } } } });
  process.exit(0);
}
const page = (items, connection, selection) => {
  const marker = connection + '(first: 100, after: "';
  const start = Number(selection.split(marker)[1]?.split('"')[0] ?? 0);
   const end = Math.min(start + 100, items.length);
   if (start > 0 && state.repeatTerminal === (query.includes("ParkedThreadPages") ? "threadComments" : connection))
     return { totalCount: items.length, nodes: items.slice(0, 100), pageInfo: { hasNextPage: false, endCursor: String(start) } };
  return { totalCount: items.length, nodes: items.slice(start, end), pageInfo: { hasNextPage: end < items.length, endCursor: String(end) } };
};
const feedbackComment = (comment) => ({ id: comment.id, body: comment.body ?? "", updatedAt: comment.updatedAt ?? "2000-01-01T00:00:00Z", url: "https://github.com/c/" + comment.id, author: author(comment.author ?? "reviewer") });
const prFacts = (pr, selection = query) => {
  const facts = {
    mergeQueueEntry: pr.queueEntry ? { id: pr.queueEntry } : null,
    state: pr.state, baseRefName: pr.baseRefName ?? "main", headRefName: pr.headRefName, headRefOid: headOf(pr), isDraft: pr.isDraft ?? false, reviewDecision: pr.reviewDecision ?? null, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    reviews: page((pr.reviews ?? []).map((review) => ({ ...feedbackComment(review), state: review.state })), "reviews", selection),
    comments: page((pr.comments ?? []).map(feedbackComment), "comments", selection),
    reviewThreads: page((pr.threads ?? []).map((thread) => ({ id: thread.id, isResolved: thread.resolved ?? false, path: thread.path ?? "file.ts", comments: page(thread.comments.map(feedbackComment), "threadComments", selection) })), "reviewThreads", selection),
    commits: nodes([{ commit: { statusCheckRollup: pr.checks === null ? null : { contexts: { totalCount: pr.totalChecks ?? (pr.checks ?? []).length, nodes: (pr.checks ?? []).slice(0, 100).map(check) } } } }]),
  };
  if (state.omitQueueEntry) delete facts.mergeQueueEntry;
  return facts;
};
if (query.includes("ParkedThreadPages")) {
  const data = {};
  for (const match of query.matchAll(/(t\\d+): node\\(id: "([^"]+)"\\) \\{([\\s\\S]*?)(?=t\\d+: node|$)/g)) {
    const pr = state.pulls.find(row => row.threads?.some(thread => thread.id === match[2]));
    const thread = pr?.threads.find(thread => thread.id === match[2]);
    data[match[1]] = thread === undefined ? null : { pullRequest: { headRefOid: headOf(pr) }, comments: page(thread.comments.map(feedbackComment), "comments", match[3]) };
  }
  answer({ data }); process.exit(0);
}
if (query.includes("ParkedPRs") || query.includes("ParkedFeedbackPages")) {
  const data = { viewer: { login: state.viewer ?? "owner" } };
  for (const match of query.matchAll(/(r\\d+): repository\\(owner: "([^"]+)", name: "([^"]+)"\\) \\{([\\s\\S]*?)(?=r\\d+: repository|$)/g)) {
    const number = Number(/pullRequest\\(number: (\\d+)\\)/.exec(match[4])?.[1]);
    const pr = state.pulls.find(row => row.number === number);
    const parentNumber = Number(/parent: pullRequest\\(number: (\\d+)\\)/.exec(match[4])?.[1]);
    const parent = state.pulls.find(row => row.number === parentNumber);
    data[match[1]] = { defaultBranchRef: { name: state.defaultBranch ?? "main" }, viewerDefaultMergeMethod: state.mergeMethod ?? "SQUASH", pullRequest: pr === undefined ? null : prFacts(pr, match[4]), ...(parent === undefined ? {} : { parent: { state: parent.state, baseRefName: parent.baseRefName ?? "main", headRefOid: headOf(parent) } }) };
  }
  answer({ data });
  process.exit(0);
}
if (args.includes("PATCH")) {
  if (state.failPatch) { console.log("HTTP/2.0 422 Unprocessable Entity\\r\\n\\r\\n" + JSON.stringify({ message: state.failPatch })); process.exit(1); }
  const number = Number(args.find((arg) => arg.startsWith("repos/")).split("/").at(-1));
  const pr = state.pulls.find((row) => row.number === number);
  pr.baseRefName = field("base");
  await save();
  answer({ number, base: { ref: pr.baseRefName } });
} else if (query.includes("pullRequests(")) {
  const branch = field("branch");
  answer({ data: { repository: { defaultBranchRef: { name: state.defaultBranch ?? "main" }, pullRequests: nodes(state.pulls.filter((pr) => pr.headRefName === branch && pr.state === "OPEN").map((pr) => ({ number: pr.number, url: pr.url, isDraft: pr.isDraft ?? false, baseRefName: pr.baseRefName ?? "main", headRefName: pr.headRefName, headRefOid: headOf(pr), headRepository: { nameWithOwner: pr.headRepository } }))) } } });
} else if (query.includes("ReadyFacts")) {
  const pr = state.pulls.find((row) => row.number === Number(field("number")));
  answer({ data: { viewer: { login: state.viewer ?? "owner" }, repository: { pullRequest: {
    id: "PR_" + pr.number, state: pr.state, isDraft: pr.isDraft ?? false, headRefOid: headOf(pr),
    comments: nodes((pr.comments ?? []).map((comment) => ({ id: comment.id, body: comment.body, url: "https://github.com/c/" + comment.id, author: author(comment.author ?? "reviewer") }))),
  } } } });
} else if (query.includes("updateIssueComment")) {
  const comment = state.pulls.flatMap((row) => row.comments ?? []).find((row) => row.id === field("id"));
  comment.body = field("body");
  (state.updated ??= []).push({ id: comment.id, body: comment.body });
  await save();
  answer({ data: { updateIssueComment: { issueComment: { id: comment.id } } } });
} else if (query.includes("markPullRequestReadyForReview")) {
  const pr = state.pulls.find((row) => "PR_" + row.number === field("id"));
  (state.readied ??= []).push(pr.number);
  pr.isDraft = false;
  await save();
  if (state.readyLost) { state.readyLost = false; await save(); console.log("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n" + JSON.stringify({ message: "lost" })); process.exit(1); }
  answer({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
} else if (query.includes("RelayParent")) {
  const number = Number(field("number"));
  const index = state.pulls.findIndex((pr) => pr.number === number);
  const change = (state.parentQueue ??= []).shift();
  if (change) state.pulls[index] = { ...state.pulls[index], ...change };
  await save();
  const pr = state.pulls[index];
  answer({ data: { repository: { pullRequest: { state: pr.state, baseRefName: pr.baseRefName ?? "main", headRefOid: headOf(pr) } } } });
} else {
  const number = Number(field("number"));
  const index = state.pulls.findIndex((pr) => pr.number === number);
  const change = state.queue.shift();
  // A no-op read must not overwrite a concurrent merge with its older snapshot.
  if (change) { state.pulls[index] = { ...state.pulls[index], ...change }; await save(); }
  const pr = state.pulls[index];
  if (race) {
    trace("observation-finished", state);
    if (staleReader) await Bun.write(root + "/merge-race-stale-finished", "");
    else if (existsSync(root + "/merge-race-saved")) await Bun.write(root + "/merge-race-verified", "");
  }
  answer({ data: { viewer: { login: state.viewer ?? "owner" }, repository: { defaultBranchRef: { name: state.defaultBranch ?? "main" }, viewerDefaultMergeMethod: state.mergeMethod ?? "SQUASH", pullRequest: prFacts(pr) } } });
}
`;
}
