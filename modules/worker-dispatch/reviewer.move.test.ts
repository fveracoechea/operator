import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { Err, Ok, OkAsync } from "unthrown";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { git, removeReviewerOrigin, reviewerDoubles, reviewerProject } from "./reviewer-fixture.ts";
import { moveReviewer } from "./reviewer.ts";

let doubles: ReturnType<typeof reviewerDoubles>;
let project: Awaited<ReturnType<typeof reviewerProject>>;
let worktree = "";

beforeEach(async () => {
  project = await reviewerProject();
  doubles = reviewerDoubles(project);
  worktree = `${project.root}/reviewer`;
});
afterAll(removeReviewerOrigin);
afterEach(async () => {
  mock.restore();
  await rm(project.root, { recursive: true, force: true });
});

function at(commit: string) {
  git(project.checkout, "worktree", "add", "-q", "--detach", worktree, commit);
}

function move(from: string, to: string, number = 7) {
  return moveReviewer({
    checkout: project.checkout,
    repository: "example/one",
    number,
    worktree,
    from,
    to,
  });
}

test("a new commit on the reviewed head fast-forwards the worktree", async () => {
  at(project.base);
  expect(await move(project.base, project.head)).toEqual(Ok({ mode: "fast-forward" }));
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.head);
  expect(await Bun.file(`${worktree}/file.txt`).text()).toBe("head\n");
  expect(git(project.checkout, "rev-parse", "refs/remotes/origin/pr/7")).toBe(project.head);
  expect(doubles.githubRemote).toHaveBeenCalledWith({
    checkout: project.checkout,
    repository: "example/one",
  });
});

test("a force push resets the worktree to the new head", async () => {
  at(project.head);
  expect(await move(project.head, project.forced, 9)).toEqual(Ok({ mode: "force-push" }));
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.forced);
  expect(await Bun.file(`${worktree}/file.txt`).text()).toBe("forced\n");
  expect(git(worktree, "status", "--porcelain")).toBe("");
});

test("a worktree already at the new head stays and reports the move mode", async () => {
  at(project.head);
  expect(await move(project.base, project.head)).toEqual(Ok({ mode: "fast-forward" }));
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.head);
  git(worktree, "checkout", "-q", "--detach", project.forced);
  expect(await move(project.head, project.forced, 9)).toEqual(Ok({ mode: "force-push" }));
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.forced);
});

test("a missing, changed, or foreign worktree is kept and refused", async () => {
  const refused = Err({
    reason: "review_worktree_changed",
    detail: `The reviewer worktree ${worktree} is missing, changed, or not at ${project.base}. Ask the person what to keep.`,
  });
  expect(await move(project.base, project.head)).toEqual(refused);
  at(project.forced);
  expect(await move(project.base, project.head)).toEqual(refused);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.forced);
  git(worktree, "checkout", "-q", "--detach", project.base);
  await Bun.write(`${worktree}/notes.md`, "keep\n");
  expect(await move(project.base, project.head)).toEqual(refused);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.base);
  expect(await Bun.file(`${worktree}/notes.md`).text()).toBe("keep\n");
});

test("a missing remote, PR ref, or new head refuses the move", async () => {
  at(project.base);
  spyOn(Projects, "githubRemote").mockReturnValue(OkAsync(null));
  expect(await move(project.base, project.head)).toEqual(
    Err({
      reason: "review_fetch_failed",
      detail: "The controlling checkout has no remote for example/one.",
    }),
  );
  spyOn(Projects, "githubRemote").mockReturnValue(OkAsync("origin"));
  expect(await move(project.base, project.head, 8)).toEqual(
    Err({
      reason: "review_fetch_failed",
      detail: `Git could not fetch ${project.head} of PR #8 from origin.`,
    }),
  );
  const unknown = "0".repeat(40);
  expect(await move(project.base, unknown)).toEqual(
    Err({
      reason: "review_fetch_failed",
      detail: `Git could not fetch ${unknown} of PR #7 from origin.`,
    }),
  );
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.base);
});

test.each([
  { name: "fast-forward", from: "base", to: "head", number: 7 },
  { name: "reset", from: "head", to: "forced", number: 9 },
] as const)("a $name that Git refuses keeps the worktree", async ({ from, to, number }) => {
  at(project[from]);
  await Bun.write(`${git(worktree, "rev-parse", "--absolute-git-dir")}/index.lock`, "");
  expect(await move(project[from], project[to], number)).toEqual(
    Err({
      reason: "review_worktree_changed",
      detail: `Git could not move ${worktree} to ${project[to]}.`,
    }),
  );
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project[from]);
});

test("a Git process that cannot start is an I/O failure", async () => {
  spyOn(ToolInvocation, "run").mockRejectedValue(
    Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
  );
  expect(await move(project.base, project.head)).toMatchObject({
    tag: "Err",
    error: { reason: "dispatch_io_failed" },
  });
});

test("a worktree already at the new head is not touched, even when Git could not move it", async () => {
  at(project.forced);
  await Bun.write(`${git(worktree, "rev-parse", "--absolute-git-dir")}/index.lock`, "");
  expect(await move(project.head, project.forced, 9)).toEqual(Ok({ mode: "force-push" }));
});

test("a missing worktree is refused without Git running in another directory", async () => {
  // The process directory is a clean checkout at the old head, which a move could act on.
  const elsewhere = `${project.root}/elsewhere`;
  git(project.checkout, "worktree", "add", "-q", "--detach", elsewhere, project.base);
  const directory = process.cwd();
  process.chdir(elsewhere);
  try {
    expect(await move(project.base, project.head)).toMatchObject({
      tag: "Err",
      error: { reason: "review_worktree_changed" },
    });
  } finally {
    process.chdir(directory);
  }
  expect(git(elsewhere, "rev-parse", "HEAD")).toBe(project.base);
});
