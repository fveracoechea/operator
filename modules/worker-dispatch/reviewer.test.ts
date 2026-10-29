import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import {
  git,
  recordPrepared,
  removeReviewerOrigin,
  reviewerDoubles,
  reviewerProject,
} from "./reviewer-fixture.ts";
import { launchReviewer, type ReviewerLaunch } from "./reviewer.ts";

// A mutant that waits for a preparation that never comes fails here instead of at the run timeout.
setDefaultTimeout(10000);

let project: Awaited<ReturnType<typeof reviewerProject>>;
let doubles: ReturnType<typeof reviewerDoubles>;
let recorded: unknown[] = [];

beforeEach(async () => {
  project = await reviewerProject();
  doubles = reviewerDoubles(project);
  recorded = [];
});
afterAll(removeReviewerOrigin);
afterEach(async () => {
  mock.restore();
  await rm(project.root, { recursive: true, force: true });
});

function request(change: Partial<ReviewerLaunch> = {}): ReviewerLaunch {
  return {
    paths: project.paths,
    checkout: project.checkout,
    repository: "example/one",
    number: 7,
    head: project.head,
    exactHead: true,
    nameBase: "review-7",
    branchBase: "review/7",
    profile: "careful",
    reuse: null,
    brief: {
      file: `${project.root}/briefs/7/brief.md`,
      render: (placement) => `brief ${placement.worktree} ${placement.branch}`,
    },
    record: (recordedChange) => {
      recorded.push(recordedChange);
      return Ok(undefined);
    },
    ...change,
  };
}

async function snapshot(host = "claude-code") {
  const manifest = await OperatorRelease.manifest();
  return JSON.stringify({
    host,
    model: "claude-resolved",
    requestedModel: "claude",
    reasoningEffort: "high",
    profile: "careful",
    release: {
      version: manifest.version,
      commit: manifest.commit,
      artifactIdentity: manifest.artifactIdentity,
    },
    skills: await OwnedSkills.identities(),
  });
}

test("a first start creates a worktree at the PR head and starts the reviewer on it", async () => {
  const worktree = `${project.root}/worktrees/review-7`;
  expect(await launchReviewer(request())).toEqual(
    Ok({
      name: "review-7",
      branch: "review/7",
      host: "claude-code",
      model: "claude-resolved",
      reasoningEffort: "high",
      profile: "careful",
      paneId: "p2",
      worktreePath: worktree,
      preparation: "fresh ready",
      brief: `${project.root}/briefs/7/brief.md`,
    }),
  );
  expect(recorded).toEqual([
    {
      name: "review-7",
      branch: "review/7",
      herdrSocket: "fixture.sock",
      launch: await snapshot(),
    },
    { workspaceId: "w1" },
    { tabId: "t2", paneId: "p2", worktreePath: worktree, worktreeWorkspaceId: "w2" },
  ]);
  expect(doubles.githubRemote).toHaveBeenCalledWith({
    checkout: project.checkout,
    repository: "example/one",
  });
  expect(doubles.tabLabels).toHaveBeenCalledWith("w1");
  expect(doubles.createWorkspace).not.toHaveBeenCalled();
  expect(doubles.createWorktree).toHaveBeenCalledWith({
    workspaceId: "w1",
    branch: "review/7",
    label: "review-7",
    base: project.head,
  });
  expect(doubles.openWorktree).not.toHaveBeenCalled();
  expect(doubles.startAgent).toHaveBeenCalledWith({
    name: "review-7",
    kind: "claude",
    paneId: "p2",
    args: ["--model", "claude-resolved"],
  });
  expect(doubles.prompt).toHaveBeenCalledWith({
    name: "review-7",
    text: `Read ${project.root}/briefs/7/brief.md and follow it.`,
  });
  expect(await Bun.file(`${project.root}/briefs/7/brief.md`).text()).toBe(
    `brief ${worktree} review/7`,
  );
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.head);
  expect(git(project.checkout, "rev-parse", "refs/remotes/origin/pr/7")).toBe(project.head);
});

test("an OpenCode reviewer starts as an OpenCode agent", async () => {
  spyOn(DeviceSettings, "resolve").mockReturnValue(
    OkAsync({
      host: "opencode" as const,
      model: "claude-resolved",
      requestedModel: "claude",
      reasoningEffort: "high",
      command: { tool: "opencode", args: ["mini"] },
      role: "workerAgent" as const,
      profile: "careful",
    }),
  );
  expect(await launchReviewer(request())).toMatchObject({ tag: "Ok", value: { host: "opencode" } });
  expect(doubles.startAgent).toHaveBeenCalledWith({
    name: "review-7",
    kind: "opencode",
    paneId: "p2",
    args: ["mini"],
  });
  expect(recorded[0]).toMatchObject({ launch: await snapshot("opencode") });
});

test("without a project workspace, the start creates one named for the repository", async () => {
  doubles.workspaces.mockReturnValue(
    OkAsync([{ workspaceId: "w9", label: "other", checkout: project.root, linked: false }]),
  );
  expect(await launchReviewer(request())).toMatchObject({ tag: "Ok" });
  expect(doubles.tabLabels).not.toHaveBeenCalled();
  expect(doubles.createWorkspace).toHaveBeenCalledWith({
    cwd: project.checkout,
    label: "one",
  });
  expect(recorded[1]).toEqual({ workspaceId: "w-new" });
  expect(doubles.createWorktree).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "w-new" }),
  );
});

test("every taken agent, tab, workspace, or branch name is skipped", async () => {
  doubles.agentNames.mockReturnValue(OkAsync(["review-7"]));
  doubles.tabLabels.mockReturnValue(OkAsync(["review-7-2"]));
  doubles.workspaces.mockReturnValue(
    OkAsync([
      { workspaceId: "w1", label: "review-7-3", checkout: project.checkout, linked: false },
    ]),
  );
  git(project.checkout, "branch", "review/7-4");
  expect(await launchReviewer(request())).toMatchObject({
    tag: "Ok",
    value: { name: "review-7-5", branch: "review/7-5" },
  });
});

test("a start with no free name refuses before it records anything", async () => {
  doubles.agentNames.mockReturnValue(
    OkAsync(["review-7", ...Array.from({ length: 998 }, (_, index) => `review-7-${index + 2}`)]),
  );
  expect(await launchReviewer(request())).toEqual(
    Err({
      reason: "launch_name_exhausted",
      detail: "No free reviewer name or branch remains. Nothing was launched.",
    }),
  );
  expect(recorded).toEqual([]);
});

test("a first start refuses a PR that moved, and a replacement keeps the recorded head", async () => {
  expect(await launchReviewer(request({ head: project.base }))).toEqual(
    Err({
      reason: "review_head_moved",
      detail: `PR #7 moved to ${project.head} after it was read. Start the reviewer again. Nothing was launched.`,
    }),
  );
  expect(recorded).toEqual([]);
  expect(await launchReviewer(request({ head: project.base, exactHead: false }))).toMatchObject({
    tag: "Ok",
  });
  expect(doubles.createWorktree).toHaveBeenCalledWith(
    expect.objectContaining({ base: project.base }),
  );
  expect(git(`${project.root}/worktrees/review-7`, "rev-parse", "HEAD")).toBe(project.base);
});

test("a replacement whose recorded head Git does not hold refuses as a moved PR", async () => {
  const unknown = "0".repeat(40);
  expect(await launchReviewer(request({ head: unknown, exactHead: false }))).toEqual(
    Err({
      reason: "review_head_moved",
      detail: `PR #7 moved to ${project.head} after it was read. Start the reviewer again. Nothing was launched.`,
    }),
  );
});

test("a missing remote or PR ref refuses the start", async () => {
  spyOn(Projects, "githubRemote").mockReturnValue(OkAsync(null));
  expect(await launchReviewer(request())).toEqual(
    Err({
      reason: "review_fetch_failed",
      detail: "The controlling checkout has no remote for example/one. Nothing was launched.",
    }),
  );
  spyOn(Projects, "githubRemote").mockReturnValue(OkAsync("origin"));
  // A replacement whose head Git holds still needs the PR ref.
  expect(
    await launchReviewer(request({ number: 8, head: project.base, exactHead: false })),
  ).toEqual(
    Err({
      reason: "review_fetch_failed",
      detail: "Git could not fetch PR #8 from origin. Nothing was launched.",
    }),
  );
  expect(recorded).toEqual([]);
  expect(doubles.createWorktree).not.toHaveBeenCalled();
});

test("a recorded worktree at the PR head is reopened on its own branch", async () => {
  const worktree = `${project.root}/reused`;
  git(project.checkout, "worktree", "add", "-q", "-b", "review/old", worktree, project.head);
  recordPrepared(project.paths, worktree, "earlier ready");
  // A reopened worktree keeps its branch, so a taken branch base does not rename it.
  git(project.checkout, "branch", "review/7");
  expect(
    await launchReviewer(request({ reuse: { path: worktree, branch: "review/old" } })),
  ).toMatchObject({
    tag: "Ok",
    value: {
      name: "review-7",
      branch: "review/old",
      paneId: "p3",
      worktreePath: worktree,
      preparation: "earlier ready",
    },
  });
  expect(doubles.createWorktree).not.toHaveBeenCalled();
  expect(doubles.openWorktree).toHaveBeenCalledWith({
    workspaceId: "w1",
    path: worktree,
    label: "review-7",
  });
  expect(recorded[2]).toEqual({
    tabId: "t3",
    paneId: "p3",
    worktreePath: worktree,
    worktreeWorkspaceId: "w3",
  });
  expect(await Bun.file(`${project.root}/briefs/7/brief.md`).text()).toBe(
    `brief ${worktree} review/old`,
  );
});

test("a clean recorded worktree on an older head moves to the PR head", async () => {
  const worktree = `${project.root}/reused`;
  git(project.checkout, "worktree", "add", "-q", "-b", "review/old", worktree, project.base);
  recordPrepared(project.paths, worktree, "earlier ready");
  expect(
    await launchReviewer(request({ reuse: { path: worktree, branch: "review/old" } })),
  ).toMatchObject({ tag: "Ok", value: { worktreePath: worktree } });
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.head);
  expect(await Bun.file(`${worktree}/file.txt`).text()).toBe("head\n");
});

test("a changed recorded worktree stays, and the start refuses", async () => {
  const worktree = `${project.root}/reused`;
  git(project.checkout, "worktree", "add", "-q", "-b", "review/old", worktree, project.base);
  await Bun.write(`${worktree}/notes.md`, "keep\n");
  expect(
    await launchReviewer(request({ reuse: { path: worktree, branch: "review/old" } })),
  ).toEqual(
    Err({
      reason: "review_worktree_changed",
      detail: `The recorded reviewer worktree ${worktree} has changes and is not at the PR head ${project.head}. Ask the person what to keep. Nothing was launched.`,
    }),
  );
  expect(git(worktree, "rev-parse", "HEAD")).toBe(project.base);
  expect(doubles.openWorktree).not.toHaveBeenCalled();
});

test("a recorded worktree that Git cannot move refuses the start", async () => {
  const worktree = `${project.root}/reused`;
  git(project.checkout, "worktree", "add", "-q", "-b", "review/old", worktree, project.base);
  await Bun.write(`${git(worktree, "rev-parse", "--absolute-git-dir")}/index.lock`, "");
  expect(
    await launchReviewer(request({ reuse: { path: worktree, branch: "review/old" } })),
  ).toEqual(
    Err({
      reason: "review_worktree_changed",
      detail: `Git could not move ${worktree} to the PR head ${project.head}. Nothing was launched.`,
    }),
  );
  expect(doubles.openWorktree).not.toHaveBeenCalled();
});

test("a recorded worktree that is gone is created again on its branch", async () => {
  expect(
    await launchReviewer(
      request({ reuse: { path: `${project.root}/gone`, branch: "review/old" } }),
    ),
  ).toMatchObject({ tag: "Ok", value: { branch: "review/old", preparation: "fresh ready" } });
  expect(doubles.createWorktree).toHaveBeenCalledWith({
    workspaceId: "w1",
    branch: "review/old",
    label: "review-7",
    base: project.head,
  });
  expect(doubles.openWorktree).not.toHaveBeenCalled();
});

test("a refused record stops the start before Herdr creates anything", async () => {
  const refusal = { reason: "state_failed", detail: "The record was refused." };
  expect(await launchReviewer(request({ record: () => Err(refusal) }))).toEqual(Err(refusal));
  expect(doubles.createWorkspace).not.toHaveBeenCalled();
  expect(doubles.createWorktree).not.toHaveBeenCalled();
});

test("a brief that cannot be written stops the start before the agent", async () => {
  await Bun.write(`${project.root}/blocker`, "file\n");
  expect(
    await launchReviewer(
      request({
        brief: { file: `${project.root}/blocker/brief.md`, render: () => "brief" },
      }),
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "dispatch_io_failed" } });
  expect(doubles.startAgent).not.toHaveBeenCalled();
});

test("a Git process that cannot start is an I/O failure", async () => {
  spyOn(ToolInvocation, "run").mockRejectedValue(
    Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
  );
  expect(await launchReviewer(request())).toMatchObject({
    tag: "Err",
    error: { reason: "dispatch_io_failed" },
  });
});

test("Herdr failures stop the start", async () => {
  const refusal = { reason: "herdr_failed" as const, detail: "refused" };
  spyOn(Herdr, "prompt").mockReturnValue(ErrAsync(refusal));
  expect(await launchReviewer(request())).toEqual(Err(refusal));
});

test("a Git process that cannot start in a recorded worktree is an I/O failure", async () => {
  const worktree = `${project.root}/reused`;
  git(project.checkout, "worktree", "add", "-q", "-b", "review/old", worktree, project.base);
  const run = ToolInvocation.run.bind(ToolInvocation);
  spyOn(ToolInvocation, "run").mockImplementation((input) =>
    input.cwd === worktree
      ? Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }))
      : run(input),
  );
  expect(
    await launchReviewer(request({ reuse: { path: worktree, branch: "review/old" } })),
  ).toMatchObject({ tag: "Err", error: { reason: "dispatch_io_failed" } });
  expect(doubles.openWorktree).not.toHaveBeenCalled();
});

test("a fetch that fails refuses the start, even with an earlier fetched PR ref", async () => {
  git(project.checkout, "update-ref", "refs/remotes/origin/pr/7", project.head);
  git(project.checkout, "remote", "set-url", "origin", `${project.root}/missing.git`);
  expect(await launchReviewer(request())).toEqual(
    Err({
      reason: "review_fetch_failed",
      detail: "Git could not fetch PR #7 from origin. Nothing was launched.",
    }),
  );
  expect(recorded).toEqual([]);
});

test("a recorded worktree at the PR head is reopened with its changes kept", async () => {
  const worktree = `${project.root}/reused`;
  git(project.checkout, "worktree", "add", "-q", "-b", "review/old", worktree, project.head);
  recordPrepared(project.paths, worktree, "earlier ready");
  await Bun.write(`${worktree}/notes.md`, "keep\n");
  expect(
    await launchReviewer(request({ reuse: { path: worktree, branch: "review/old" } })),
  ).toMatchObject({ tag: "Ok", value: { worktreePath: worktree } });
  expect(await Bun.file(`${worktree}/notes.md`).text()).toBe("keep\n");
  expect(doubles.openWorktree).toHaveBeenCalled();
});

test("a new worktree whose hook failed stops the start before the agent", async () => {
  doubles.preparation.state = "failed";
  doubles.preparation.detail = "hook failed";
  expect(await launchReviewer(request())).toEqual(
    Err({ reason: "worktree_setup_failed", detail: "hook failed" }),
  );
  expect(doubles.startAgent).not.toHaveBeenCalled();
});
