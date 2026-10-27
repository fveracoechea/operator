/**
 * A controlled `gh` executable for public CLI tests. It answers `gh auth status` and the two
 * GraphQL reads of the PR feedback loop from one JSON file, and logs each call. Each PR read
 * first applies the next queued change, so a test can script what later polls observe.
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
const query = field("query") ?? "";
const nodes = (items) => ({ nodes: items });
const author = (login) => (login === null ? null : { login });
if (query.includes("pullRequests(")) {
  const branch = field("branch");
  answer({ data: { repository: { pullRequests: nodes(state.pulls.filter((pr) => pr.headRefName === branch && pr.state === "OPEN").map((pr) => ({ number: pr.number, url: pr.url, headRefName: pr.headRefName, headRepository: { nameWithOwner: pr.headRepository } }))) } } });
} else {
  const number = Number(field("number"));
  const index = state.pulls.findIndex((pr) => pr.number === number);
  const change = state.queue.shift();
  if (change) state.pulls[index] = { ...state.pulls[index], ...change };
  await Bun.write(stateFile, JSON.stringify(state));
  const pr = state.pulls[index];
  answer({ data: { viewer: { login: state.viewer ?? "owner" }, repository: { defaultBranchRef: { name: state.defaultBranch ?? "main" }, pullRequest: {
    state: pr.state, baseRefName: pr.baseRefName ?? "main", headRefName: pr.headRefName, headRefOid: pr.head ?? "head-1", reviewDecision: pr.reviewDecision ?? null,
    reviews: nodes((pr.reviews ?? []).map((review) => ({ id: review.id, state: review.state, body: review.body ?? "", url: "https://github.com/r/" + review.id, author: author(review.author ?? "reviewer") }))),
    comments: nodes((pr.comments ?? []).map((comment) => ({ id: comment.id, body: comment.body, url: "https://github.com/c/" + comment.id, author: author(comment.author ?? "reviewer") }))),
    reviewThreads: nodes((pr.threads ?? []).map((thread) => ({ isResolved: thread.resolved ?? false, path: thread.path ?? "file.ts", comments: nodes(thread.comments.map((comment) => ({ id: comment.id, body: comment.body, url: "https://github.com/t/" + comment.id, author: author(comment.author ?? "reviewer") }))) }))),
    commits: nodes([{ commit: { statusCheckRollup: (pr.checks ?? []).length === 0 ? null : { contexts: nodes(pr.checks.map((check) => check.status ? { __typename: "StatusContext", context: check.name, state: check.status, targetUrl: null } : { __typename: "CheckRun", name: check.name, status: check.conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion: check.conclusion ?? null, detailsUrl: "https://ci/" + check.name })) } } }]),
  } } } });
}
`;
}
