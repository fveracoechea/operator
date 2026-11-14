import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, realpath, or recursive removal API.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OkAsync, type Result } from "unthrown";
import { GithubApi } from "../github-api/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { prepareBranch, readAdoption } from "./adoption.ts";
import { git, removeDevices } from "./dispatch-fixture.ts";
import { expectRefusalContext } from "../../lib/cli-result-fixture.ts";

const branch = "feature/existing";
let root = "";
let checkout = "";
let head = "";

/** A checkout whose reachable remote `local` holds the PR branch one commit past main. */
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-adoption-")));
  checkout = `${root}/checkout`;
  git(root, "init", "-q", "--bare", "-b", "main", `${root}/remote.git`);
  await Bun.write(`${checkout}/README.md`, "fixture\n", { createPath: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "remote", "add", "local", `${root}/remote.git`);
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fixture");
  git(checkout, "checkout", "-q", "-b", branch);
  git(checkout, "commit", "-q", "--allow-empty", "-m", "existing work");
  git(checkout, "push", "-q", "local", branch);
  head = git(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "-q", "main");
  git(checkout, "branch", "-q", "-D", branch);
  spyOn(Projects, "githubRemote").mockReturnValue(OkAsync("local"));
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});
afterAll(removeDevices);

function request() {
  return { checkout, repository: "example/one", number: 41, branch };
}

/** Checks the refusal's reason and that its detail names what refused. */
function refused(
  result: Result<unknown, { reason: string; detail: string }>,
  reason: string,
  detail: string,
  state: Record<string, unknown>,
  decider = "person",
) {
  expect(result).toMatchObject({ tag: "Err", error: { reason, state, next: { decider } } });
  if (result.tag === "Err") expectRefusalContext(result.error);
  expect(result.tag === "Err" ? result.error.detail : "").toContain(detail);
}

function answer(pr: { state?: string; draft?: boolean; ref?: string; repo?: string | null }) {
  spyOn(GithubApi, "call").mockResolvedValue({
    status: "succeeded",
    value: {
      httpStatus: 200,
      body: {
        html_url: "https://github.com/example/one/pull/41",
        state: pr.state ?? "open",
        draft: pr.draft ?? false,
        head: {
          ref: pr.ref ?? branch,
          repo: pr.repo === null ? null : { full_name: pr.repo ?? "example/one" },
        },
      },
    },
  });
}

test("an open PR from the planned branch of this repository is adopted with its draft state", async () => {
  answer({ draft: true, repo: "Example/One" });
  expect(await readAdoption({ repository: "example/one", number: 41, branch })).toMatchObject({
    tag: "Ok",
    value: { number: 41, url: "https://github.com/example/one/pull/41", draft: true, branch },
  });
});

test.each([
  [{ state: "merged" }, "adopt_pr_not_open", "PR #41 is merged.", { prState: "merged" }],
  [
    { ref: "feature/other" },
    "adopt_pr_branch_mismatch",
    "comes from example/one:feature/other",
    { headMatches: false },
  ],
  [
    { repo: "fork/one" },
    "adopt_pr_branch_mismatch",
    "comes from fork/one:feature/existing",
    { headMatches: false },
  ],
  [
    { repo: null },
    "adopt_pr_branch_mismatch",
    "comes from a deleted repository:",
    { headMatches: false },
  ],
])("PR %o refuses with %s", async (pr, reason, detail, state) => {
  answer(pr);
  const result = await readAdoption({ repository: "example/one", number: 41, branch });
  expect(result).toMatchObject({
    tag: "Err",
    error: { reason, state, next: { decider: "super-agent" } },
  });
  if (result.tag === "Err") expectRefusalContext(result.error);
  expect(result.tag === "Err" ? result.error.detail : "").toContain(detail);
});

test("an unreadable or unexpected answer refuses", async () => {
  spyOn(GithubApi, "call").mockResolvedValue({ status: "uncertain", detail: "timeout" });
  refused(
    await readAdoption({ repository: "example/one", number: 41, branch }),
    "adopt_pr_unreadable",
    "timeout",
    { prReadable: false },
    "super-agent",
  );
  spyOn(GithubApi, "call").mockResolvedValue({
    status: "succeeded",
    value: { httpStatus: 200, body: { state: "open" } },
  });
  refused(
    await readAdoption({ repository: "example/one", number: 41, branch }),
    "adopt_pr_unreadable",
    "unexpected",
    { prReadable: false },
    "super-agent",
  );
});

test("a missing local branch is created at the PR head, tracking the remote branch", async () => {
  expect(await prepareBranch(request())).toMatchObject({ tag: "Ok", value: undefined });
  expect(git(checkout, "rev-parse", branch)).toBe(head);
  expect(git(checkout, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`)).toBe(
    `local/${branch}`,
  );
});

test.each(["create", "move"] as const)(
  "an unconfirmed branch %s keeps local work and names the person's decision",
  async (action) => {
    if (action === "move") git(checkout, "branch", "-q", branch, "main");
    const before = git(checkout, "branch", "--list", "--format=%(objectname)", branch);
    const run = ToolInvocation.run.bind(ToolInvocation);
    spyOn(ToolInvocation, "run").mockImplementation((input) =>
      input.args.includes(action === "create" ? "--track" : "--force")
        ? Promise.resolve({ status: "completed", exitCode: 128, stdout: "", stderr: "denied" })
        : run(input),
    );
    refused(
      await prepareBranch(request()),
      "adopt_branch_unavailable",
      action === "create" ? "could not create" : "could not move",
      action === "create" ? { creationConfirmed: false } : { moveConfirmed: false },
    );
    expect(git(checkout, "branch", "--list", "--format=%(objectname)", branch)).toBe(before);
  },
);

test("a local branch behind the PR head moves forward, and one at the head stays", async () => {
  git(checkout, "branch", "-q", branch, "main");
  expect(await prepareBranch(request())).toMatchObject({ tag: "Ok" });
  expect(git(checkout, "rev-parse", branch)).toBe(head);
  expect(await prepareBranch(request())).toMatchObject({ tag: "Ok" });
  expect(git(checkout, "rev-parse", branch)).toBe(head);
});

test("a local branch with commits the PR lacks refuses and keeps them", async () => {
  git(checkout, "branch", "-q", branch, head);
  git(checkout, "checkout", "-q", branch);
  git(checkout, "commit", "-q", "--allow-empty", "-m", "one");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "two");
  const local = git(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "-q", "main");
  refused(
    await prepareBranch(request()),
    "adopt_branch_diverged",
    `${branch} has 2 commits that PR #41 lacks.`,
    { ahead: 2 },
  );
  expect(git(checkout, "rev-parse", branch)).toBe(local);
});

test("a failed comparison refuses instead of moving the branch", async () => {
  git(checkout, "branch", "-q", branch, "main");
  const before = git(checkout, "rev-parse", branch);
  const run = ToolInvocation.run.bind(ToolInvocation);
  spyOn(ToolInvocation, "run").mockImplementation((input) =>
    input.args.includes("rev-list")
      ? Promise.resolve({ status: "completed", exitCode: 128, stdout: "", stderr: "" })
      : run(input),
  );
  refused(await prepareBranch(request()), "adopt_branch_unavailable", "compare", {
    comparisonConfirmed: false,
  });
  expect(git(checkout, "rev-parse", branch)).toBe(before);
});

test("a branch checked out in a worktree refuses, with a separate reason when it is dirty", async () => {
  const elsewhere = `${root}/elsewhere`;
  git(checkout, "worktree", "add", "-q", "-b", branch, elsewhere, `local/${branch}`);
  refused(await prepareBranch(request()), "adopt_branch_checked_out", elsewhere, {
    branchCheckedOut: true,
  });
  await Bun.write(`${elsewhere}/draft.ts`, "draft\n");
  refused(await prepareBranch(request()), "adopt_branch_dirty", "with uncommitted changes", {
    branchCheckedOut: true,
  });
});

test("a branch that the remote does not have refuses", async () => {
  refused(
    await prepareBranch({ ...request(), branch: "feature/gone" }),
    "adopt_branch_unavailable",
    "feature/gone",
    { headResolved: false },
  );
  expect(git(checkout, "branch", "--list", "feature/gone")).toBe("");
});
