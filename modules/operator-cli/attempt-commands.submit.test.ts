import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { ContentIdentity } from "../content-identity/main.ts";
import { headCommit, runJson, workspaces } from "./workspace-fixture.ts";
import {
  commitArtifact,
  makeReviewWorkspace,
  type Producer,
  startProducer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";

// Each test creates a Git worktree and runs several CLI processes under the parallel CI gate.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await Bun.$`git -C ${cwd} -c user.email=t@example.com -c user.name=Test ${args}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** Commits files into the controlling checkout, so the next dispatch starts from them. */
async function seed(workspace: Workspace, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await Bun.write(`${workspace.repo}/${path}`, text);
    await git(workspace.repo, ["add", path]);
  }
  await git(workspace.repo, ["commit", "-m", "seed"]);
}

/** Writes and commits files in the Operative worktree, as one more commit of the result. */
async function commitFiles(producer: Producer, files: Record<string, string>, message = "more") {
  for (const [path, text] of Object.entries(files)) {
    await Bun.write(`${producer.worktreePath}/${path}`, text);
    await git(producer.worktreePath, ["add", path]);
  }
  await git(producer.worktreePath, ["commit", "-m", message]);
}

function reasons(result: { json: { blockers: Array<{ reason: string }> } }): string[] {
  return result.json.blockers.map((one) => one.reason);
}

/** A path artifact that the base commit already holds, so a result can name it with no commit. */
async function baseArtifact(workspace: Workspace) {
  const text = "# Existing\n";
  await seed(workspace, { "docs/existing.md": text });
  return { path: "docs/existing.md", identity: ContentIdentity.ofText(text) };
}

describe("operator attempt submit checks the commit shape", () => {
  test("refuses a code result with no commit, and does not run the write-path check", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const existing = await baseArtifact(workspace);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, { ...existing, commit: base }),
    );

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("result_not_one_commit");
    expect(refused.json.blockers).toEqual([
      expect.objectContaining({ reason: "result_not_one_commit", baseCommit: base, commits: [] }),
      expect.objectContaining({ reason: "result_check_not_run", check: "write-paths" }),
    ]);
  });

  test("refuses a code result with two commits", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await commitFiles(producer, { "docs/first.md": "first\n" }, "first");
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(workspace, producer, submissionBody(producer, artifact));

    expect(refused.exitCode).toBe(4);
    expect(reasons(refused)).toEqual(["result_not_one_commit", "result_check_not_run"]);
    expect(refused.json.blockers[0].commits).toHaveLength(2);
  });

  test("refuses a code result whose one commit has a different parent", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await seed(workspace, { "docs/later.md": "later\n" });
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const parent = await git(producer.worktreePath, ["rev-parse", "HEAD~1"]);
    await git(producer.worktreePath, ["reset", "--hard", parent]);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(workspace, producer, submissionBody(producer, artifact));

    expect(refused.exitCode).toBe(4);
    expect(refused.json.blockers[0]).toMatchObject({
      reason: "result_not_one_commit",
      baseCommit: base,
      commits: [{ commit: artifact.commit, parents: [parent] }],
    });
  });

  test("refuses a code result whose one new commit is a merge", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const branch = await git(producer.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    await git(producer.worktreePath, ["checkout", "-b", "side"]);
    await commitFiles(producer, { "docs/side.md": "side\n" }, "side");
    const side = await git(producer.worktreePath, ["rev-parse", "HEAD"]);
    await git(producer.worktreePath, ["checkout", branch]);
    await git(producer.worktreePath, ["merge", "--no-ff", "--no-commit", "side"]);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(workspace, producer, submissionBody(producer, artifact));

    expect(refused.exitCode).toBe(4);
    expect(refused.json.blockers[0]).toMatchObject({
      reason: "result_not_one_commit",
      baseCommit: base,
      commits: expect.arrayContaining([{ commit: artifact.commit, parents: [base, side] }]),
    });
  });

  test("refuses a stated result commit that is not the one commit", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, { ...artifact, commit: base }),
    );

    expect(refused.exitCode).toBe(4);
    expect(reasons(refused)).toEqual(["result_not_one_commit", "result_check_not_run"]);
  });

  test("refuses a stated base commit that is not the base of the dispatch", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(
      workspace,
      producer,
      submissionBody({ ...producer, baseCommit: artifact.commit }, artifact),
    );

    expect(refused.exitCode).toBe(4);
    expect(refused.json.blockers[0]).toMatchObject({
      reason: "result_not_one_commit",
      baseCommit: producer.baseCommit,
      statedBase: artifact.commit,
    });
  });
});

describe("operator attempt submit checks the working tree and the write paths", () => {
  test("refuses uncommitted work and names each file", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    await Bun.write(`${producer.worktreePath}/docs/result.md`, "# Edited after the commit\n");
    await Bun.write(`${producer.worktreePath}/docs/notes/draft.md`, "draft\n");

    const refused = await submit(workspace, producer, submissionBody(producer, artifact));

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("uncommitted_work");
    expect(refused.json.blockers).toEqual([
      { reason: "uncommitted_work", paths: ["docs/notes/draft.md", "docs/result.md"] },
    ]);
  });

  test("refuses each file outside the write paths, the old path of a rename and a delete too", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await seed(workspace, { "modules/old.ts": "old\n", "modules/gone.ts": "gone\n" });
    const producer = await startProducer(workspace);
    await Bun.$`mkdir -p ${producer.worktreePath}/docs`;
    await git(producer.worktreePath, ["mv", "modules/old.ts", "docs/old.ts"]);
    await git(producer.worktreePath, ["rm", "-q", "modules/gone.ts"]);
    await Bun.write(`${producer.worktreePath}/src/new.ts`, "new\n");
    await git(producer.worktreePath, ["add", "src/new.ts"]);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(workspace, producer, submissionBody(producer, artifact));

    expect(refused.exitCode).toBe(4);
    expect(refused.json.blockers).toEqual([
      {
        reason: "outside_write_paths",
        paths: ["modules/gone.ts", "modules/old.ts", "src/new.ts"],
        writePaths: ["docs/"],
      },
    ]);
  });

  test("a wrong commit shape and a dirty tree report both, and the write paths as not run", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const existing = await baseArtifact(workspace);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    await Bun.write(`${producer.worktreePath}/docs/draft.md`, "draft\n");

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, { ...existing, commit: base }),
    );

    expect(refused.exitCode).toBe(4);
    expect(reasons(refused)).toEqual([
      "result_not_one_commit",
      "uncommitted_work",
      "result_check_not_run",
    ]);
    expect(refused.json.blockers[1].paths).toEqual(["docs/draft.md"]);
    expect(refused.json.blockers[2]).toMatchObject({ check: "write-paths" });
  });

  test("a path artifact of a non-code result may stay uncommitted inside the write paths", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const text = "# Findings\n";
    await Bun.write(`${producer.worktreePath}/docs/findings.md`, text);
    const artifact = {
      path: "docs/findings.md",
      identity: ContentIdentity.ofText(text),
      commit: base,
    };

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, { resultKind: "non-code", code: null }),
    );

    expect(submitted.json.reason).toBe("result_submitted");
  });

  test("a path artifact of a non-code result outside the write paths is uncommitted work", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const text = "# Findings\n";
    await Bun.write(`${producer.worktreePath}/notes/findings.md`, text);
    const artifact = {
      path: "notes/findings.md",
      identity: ContentIdentity.ofText(text),
      commit: producer.baseCommit,
    };

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, { resultKind: "non-code", code: null }),
    );

    expect(refused.exitCode).toBe(4);
    expect(refused.json.blockers).toEqual([
      { reason: "uncommitted_work", paths: ["notes/findings.md"] },
    ]);
  });

  test("after a refusal the attempt still runs, and a corrected result is submitted", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    await Bun.write(`${producer.worktreePath}/docs/result.md`, "# Result\n");
    const uncommitted = {
      path: "docs/result.md",
      identity: ContentIdentity.ofText("# Result\n"),
      commit: base,
    };

    const refused = await submit(workspace, producer, submissionBody(producer, uncommitted));
    expect(reasons(refused)).toEqual([
      "result_not_one_commit",
      "uncommitted_work",
      "result_check_not_run",
    ]);

    const shown = await runJson(workspace, ["attempt", "show", "--attempt", producer.attemptId]);
    expect(shown.json.data.current).toBe(true);

    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    expect(submitted.exitCode).toBe(6);
    expect(submitted.json.reason).toBe("result_submitted");
  });
});
