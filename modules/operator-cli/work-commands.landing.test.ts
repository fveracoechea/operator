import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no file removal API.
import { rm } from "node:fs/promises";
import {
  acceptProduction,
  commitArtifact,
  makeReviewWorkspace,
  passCandidateGate,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  startSibling,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
  nextActions,
  pausedGit,
  requestId as request,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";

// Each test runs a producer, a reviewer, and gate runs through separate CLI processes.
setDefaultTimeout(90_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

/** The integration branch of the fixture source, as the first code dispatch named it. */
async function branchOf(workspace: Workspace): Promise<string> {
  const format = "--format=%(refname:short)";
  const listed =
    await Bun.$`git -C ${workspace.repo} for-each-ref ${format} refs/heads/operator/integration/`.text();
  const name = listed.trim().split("\n")[0];
  if (name === undefined || name === "") {
    throw new Error("the fixture source has no integration branch");
  }
  return name;
}

async function tipOf(workspace: Workspace, branch: string): Promise<string> {
  return (await Bun.$`git -C ${workspace.repo} rev-parse ${`refs/heads/${branch}`}`.text()).trim();
}

/** Commits, submits, and reviews one result with no finding, so only the landing is left. */
async function reviewedResult(
  workspace: Workspace,
  producer: Producer,
  options: { text?: string; path?: string } = {},
) {
  const artifact = await commitArtifact(
    workspace,
    producer,
    options.text ?? "# Result\n",
    options.path,
  );
  const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
  expect(submitted.json.reason).toBe("result_submitted");
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit, {
    worktreePath: `${workspace.root}/reviewer-${producer.assignmentId.slice(0, 8)}`,
  });
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  expect(reported.json.reason).toBe("review_reported");
  return {
    artifact,
    submissionId: submitted.json.data.submissionId as string,
    revision: submitted.json.data.revision as number,
  };
}

async function assignmentState(workspace: Workspace, assignmentId: string) {
  const frontier = await runJson(workspace, ["work", "frontier"]);
  const all = Object.values(frontier.json.data).flatMap((one) =>
    Array.isArray(one) ? (one as Array<{ assignmentId: string; state: string }>) : [],
  );
  return all.find((one) => one.assignmentId === assignmentId)?.state ?? null;
}

/** A lock file stops every ref write of Git, so the move fails after its intent is recorded. */
function lockPath(workspace: Workspace, branch: string): string {
  return `${workspace.repo}/.git/refs/heads/${branch}.lock`;
}

const SIBLING = { key: "22.2", kind: "production" as const, title: "Write the notes" };

/**
 * Moves the branch and its recorded tip to a new commit on the tip that writes `text` at `path`,
 * as an earlier landing of an equal patch would. It returns the new tip.
 */
async function holdOnBranch(
  workspace: Workspace,
  branch: string,
  change: { path: string; text: string },
): Promise<string> {
  const checkout = `${workspace.root}/held-writer`;
  await Bun.$`git -C ${workspace.repo} worktree add -q --detach ${checkout} ${branch}`.quiet();
  await Bun.write(`${checkout}/${change.path}`, change.text);
  await Bun.$`git -C ${checkout} add ${change.path}`.quiet();
  await Bun.$`git -C ${checkout} -c user.email=t@example.com -c user.name=Test commit -q -m held`.quiet();
  const tip = await headCommit(workspace, checkout);
  await Bun.$`git -C ${workspace.repo} worktree remove --force ${checkout}`.quiet();
  await Bun.$`git -C ${workspace.repo} update-ref ${`refs/heads/${branch}`} ${tip}`.quiet();
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readwrite: true,
  });
  try {
    sqlite.query("update integration_branches set recorded_tip = ?").run(tip);
  } finally {
    sqlite.close();
  }
  return tip;
}

/** Accepts one code result with no candidate gate run, in a process with its own environment. */
function acceptWith(
  workspace: Workspace,
  producer: Producer,
  result: { submissionId: string; revision: number },
  env: Record<string, string>,
) {
  return runJson(
    workspace,
    [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      producer.assignmentId,
      "--attempt",
      producer.attemptId,
      "--revision",
      String(result.revision),
      "--submission",
      result.submissionId,
    ],
    workspace.repo,
    env,
  );
}

describe("operator work accept lands the reviewed commit", () => {
  test("a commit on the recorded tip lands as itself and keeps the Operative identity", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);

    const accepted = await acceptProduction(workspace, producer, result);

    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.landing).toMatchObject({
      branch,
      kind: "fast-forward",
      from: producer.baseCommit,
      to: result.artifact.commit,
      landed: result.artifact.commit,
    });
    expect(await tipOf(workspace, branch)).toBe(result.artifact.commit);
  });

  test("refuses with a gate blocker until the candidate passes, and changes nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);

    const next = await nextActions(workspace);
    const owed = next.actions.find(
      (one) => one.action === "run_gate" && one.assignmentId === producer.assignmentId,
    );
    expect(owed).toMatchObject({
      action: "run_gate",
      command: `operator gate run --assignment ${producer.assignmentId}`,
      blocker: null,
    });
    expect(next.forAction("accept_assignment").map((one) => one.assignmentId)).not.toContain(
      producer.assignmentId,
    );

    const refused = await acceptProduction(workspace, producer, { ...result, gate: false });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.json.reason).toBe("gate_pending");
    expect(refused.json.blockers[0]).toMatchObject({
      reason: "gate_pending",
      commit: result.artifact.commit,
      tip: producer.baseCommit,
    });
    expect(await tipOf(workspace, branch)).toBe(producer.baseCommit);
    expect(await assignmentState(workspace, producer.assignmentId)).toBe("awaiting-review");

    const gated = await passCandidateGate(workspace, producer);
    expect(gated?.json.reason).toBe("gate_run_started");
    expect(gated?.json.data).toMatchObject({
      commit: result.artifact.commit,
      subject: { kind: "candidate", assignmentId: producer.assignmentId, tip: producer.baseCommit },
    });
    const ready = await nextActions(workspace);
    expect(ready.forAction("accept_assignment").map((one) => one.assignmentId)).toContain(
      producer.assignmentId,
    );
    expect(ready.forAction("run_gate").map((one) => one.assignmentId)).not.toContain(
      producer.assignmentId,
    );

    const accepted = await acceptProduction(workspace, producer, { ...result, gate: false });
    expect(accepted.json.reason).toBe("assignment_accepted");
  });

  test("a failed candidate is refused with gate_failed, lands nothing, and goes to an integration cycle", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: {
        $schema: "./node_modules/@fveracoechea/operator/gate.schema.json",
        commands: [
          {
            name: "quality",
            // The base holds no result file, so only the candidate fails.
            argv: ["sh", "-c", "test ! -f docs/result.md"],
            timeoutSeconds: 30,
          },
        ],
      },
    });
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);
    const gated = await passCandidateGate(workspace, producer);
    expect(gated?.json.reason).toBe("gate_run_started");

    const refused = await acceptProduction(workspace, producer, { ...result, gate: false });

    expect(refused.json.reason).toBe("gate_failed");
    expect(refused.json.blockers[0].runIds).toEqual([gated?.json.data.runId]);
    expect(await tipOf(workspace, branch)).toBe(producer.baseCommit);
    // The candidate points to this result, so the Operator delegates an integration cycle.
    const next = await nextActions(workspace);
    expect(next.actions.find((one) => one.assignmentId === producer.assignmentId)).toMatchObject({
      action: "delegate_rework",
      blocker: null,
      command: "operator work rework",
    });
    expect(next.forAction("run_gate").map((one) => one.assignmentId)).not.toContain(
      producer.assignmentId,
    );
    expect(next.forAction("accept_assignment").map((one) => one.assignmentId)).not.toContain(
      producer.assignmentId,
    );
  });

  test("a merge landing makes one new commit with an equal patch, the one the gate ran on", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, {
      dependents: [{ ...SIBLING, dependsOn: [], writePaths: ["notes/"] }],
    });
    const branch = await branchOf(workspace);
    const sibling = await startSibling(workspace, producer, SIBLING.key);
    const first = await reviewedResult(workspace, producer);
    const second = await reviewedResult(workspace, sibling, {
      text: "# Notes\n",
      path: "notes/notes.md",
    });
    expect((await acceptProduction(workspace, producer, first)).json.reason).toBe(
      "assignment_accepted",
    );

    const gated = await passCandidateGate(workspace, sibling);
    const checkouts = [workspace.repo, producer.worktreePath, sibling.worktreePath];
    const status = () =>
      Promise.all(checkouts.map((one) => Bun.$`git -C ${one} status --porcelain`.text()));
    const before = await status();
    const accepted = await acceptProduction(workspace, sibling, { ...second, gate: false });
    // The CLI moves a ref built only from the reviewed patch, and it writes no file (R1, D5).
    expect(await status()).toEqual(before);

    expect(accepted.json.reason).toBe("assignment_accepted");
    const landing = accepted.json.data.landing;
    expect(landing).toMatchObject({ kind: "merge", from: first.artifact.commit });
    expect(landing.to).not.toBe(second.artifact.commit);
    // The gate ran on the same commit that landed, because the plan gives it again.
    expect(gated?.json.data.commit).toBe(landing.to);
    expect(await tipOf(workspace, branch)).toBe(landing.to);
    const patch = (sha: string) =>
      Bun.$`git -C ${workspace.repo} diff-tree -p --no-renames ${sha}^ ${sha}`.text();
    expect(await patch(landing.to)).toBe(await patch(second.artifact.commit));
    const shown = (sha: string) =>
      Bun.$`git -C ${workspace.repo} show -s --format=%an%n%ae%n%ad%n%cn%n%ce%n%cd%n%B --date=raw ${sha}`.text();
    expect(await shown(landing.to)).toBe(await shown(second.artifact.commit));
  });

  test("a moved branch stops the landing, names both tips, and changes nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);
    await passCandidateGate(workspace, producer);
    // A person moves the branch to a commit that nobody reviewed.
    await Bun.$`git -C ${workspace.repo} -c user.email=p@example.com -c user.name=Person commit -q --allow-empty -m person`.quiet();
    const person = await headCommit(workspace);
    await Bun.$`git -C ${workspace.repo} update-ref ${`refs/heads/${branch}`} ${person}`.quiet();

    const refused = await acceptProduction(workspace, producer, { ...result, gate: false });

    expect(refused.json.reason).toBe("integration_branch_moved");
    expect(refused.json.blockers).toEqual([
      {
        reason: "integration_branch_moved",
        assignmentId: producer.assignmentId,
        branch,
        recordedTip: producer.baseCommit,
        found: person,
        checkedOut: [],
      },
    ]);
    expect(Object.keys(refused.json.blockers[0])).toEqual([
      "reason",
      "assignmentId",
      "branch",
      "recordedTip",
      "found",
      "checkedOut",
    ]);
    const text = await runOperator(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      producer.assignmentId,
      "--attempt",
      producer.attemptId,
      "--revision",
      String(result.revision),
      "--submission",
      result.submissionId,
    ]);
    expect(text.stdout).toBe(
      [
        `The branch ${branch} holds ${person}, and the recorded tip is ${producer.baseCommit}.`,
        "Operator never resets or adopts a moved branch. The person puts it back at the recorded tip, then accept again.",
        "Nothing was accepted.",
        "",
      ].join("\n"),
    );
    expect(await tipOf(workspace, branch)).toBe(person);
    expect(await assignmentState(workspace, producer.assignmentId)).toBe("awaiting-review");
  });

  test("a branch checked out in a worktree stops the landing and names the worktree", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);
    await passCandidateGate(workspace, producer);
    const checkout = `${workspace.root}/person-checkout`;
    await Bun.$`git -C ${workspace.repo} worktree add -q ${checkout} ${branch}`.quiet();
    const listed = (await Bun.$`git -C ${checkout} rev-parse --show-toplevel`.text()).trim();

    const refused = await acceptProduction(workspace, producer, { ...result, gate: false });

    expect(refused.json.reason).toBe("integration_branch_checked_out");
    expect(refused.json.blockers[0]).toMatchObject({ branch, worktrees: [listed] });
    expect(await tipOf(workspace, branch)).toBe(producer.baseCommit);
  });

  test("a move that did not happen is settled by a repeat, which lands again", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);
    await passCandidateGate(workspace, producer);
    await Bun.write(lockPath(workspace, branch), "");

    const stopped = await acceptProduction(workspace, producer, { ...result, gate: false });
    expect(stopped.json.reason).toBe("integration_branch_unread");
    expect(await tipOf(workspace, branch)).toBe(producer.baseCommit);
    const next = await nextActions(workspace);
    expect(
      next.actions.find(
        (one) => one.action === "settle_landing" && one.assignmentId === producer.assignmentId,
      ),
    ).toMatchObject({ command: "operator work accept" });
    // A recovery comes before every pipeline step, right after an unproven dispatch.
    expect(next.of("settle_landing").rank).toBeLessThan(next.of("accept_assignment")?.rank ?? 999);

    await rm(lockPath(workspace, branch));
    const settled = await acceptProduction(workspace, producer, { ...result, gate: false });

    expect(settled.json.reason).toBe("assignment_accepted");
    expect(await tipOf(workspace, branch)).toBe(result.artifact.commit);
    const after = await nextActions(workspace);
    expect(after.names).not.toContain("settle_landing");
  });

  test("a move that happened before its record is settled by a repeat, which records it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);
    await passCandidateGate(workspace, producer);
    await Bun.write(lockPath(workspace, branch), "");
    await acceptProduction(workspace, producer, { ...result, gate: false });
    // The move lands, and the process stops before it records the outcome.
    await rm(lockPath(workspace, branch));
    await Bun.$`git -C ${workspace.repo} update-ref ${`refs/heads/${branch}`} ${result.artifact.commit} ${producer.baseCommit}`.quiet();

    const settled = await acceptProduction(workspace, producer, { ...result, gate: false });

    expect(settled.json.reason).toBe("assignment_accepted");
    expect(settled.json.data.landing.to).toBe(result.artifact.commit);
    expect(await tipOf(workspace, branch)).toBe(result.artifact.commit);
  });

  test("--pr-head is refused as an unknown option", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const result = await reviewedResult(workspace, producer);

    const refused = await runJson(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      producer.assignmentId,
      "--attempt",
      producer.attemptId,
      "--revision",
      String(result.revision),
      "--submission",
      result.submissionId,
      "--pr-head",
      result.artifact.commit,
    ]);

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_arguments");
    expect(await assignmentState(workspace, producer.assignmentId)).toBe("awaiting-review");
  });

  test("a result whose equal patch the branch already holds is accepted and lands nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const branch = await branchOf(workspace);
    const result = await reviewedResult(workspace, producer);
    const tip = await holdOnBranch(workspace, branch, {
      path: result.artifact.path,
      text: "# Result\n",
    });

    const accepted = await acceptProduction(workspace, producer, { ...result, gate: false });

    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.landing).toMatchObject({ branch, kind: "held", from: tip, to: tip });
    expect(await tipOf(workspace, branch)).toBe(tip);
    expect(await assignmentState(workspace, producer.assignmentId)).toBe("accepted");
  });

  test("a landing planned on a tip that another acceptance moved is refused and lands nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, {
      dependents: [{ ...SIBLING, dependsOn: [], writePaths: ["notes/"] }],
    });
    const branch = await branchOf(workspace);
    const sibling = await startSibling(workspace, producer, SIBLING.key);
    const first = await reviewedResult(workspace, producer);
    const second = await reviewedResult(workspace, sibling, {
      text: "# Notes\n",
      path: "notes/notes.md",
    });
    await passCandidateGate(workspace, producer);
    await passCandidateGate(workspace, sibling);
    const pause = await pausedGit(workspace);

    // The sibling plans on the base, and it stops before it records its intent.
    const stale = acceptWith(workspace, sibling, second, pause.env);
    await pause.reached();
    const accepted = await acceptProduction(workspace, producer, { ...first, gate: false });
    expect(accepted.json.reason).toBe("assignment_accepted");
    await pause.release();
    const refused = await stale;

    expect(refused.json.reason).toBe("landing_tip_changed");
    expect(await tipOf(workspace, branch)).toBe(first.artifact.commit);
    expect(await assignmentState(workspace, sibling.assignmentId)).toBe("awaiting-review");
    const next = await nextActions(workspace);
    expect(next.names).not.toContain("settle_landing");
  });

  test("crew next offers a landing with a passing run before a new gate run of the same source", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace, undefined, {
      dependents: [{ ...SIBLING, dependsOn: [], writePaths: ["notes/"] }],
    });
    const sibling = await startSibling(workspace, producer, SIBLING.key);
    await reviewedResult(workspace, producer);
    await reviewedResult(workspace, sibling, { text: "# Notes\n", path: "notes/notes.md" });
    await passCandidateGate(workspace, producer);

    const next = await nextActions(workspace);

    const accept = next.actions.find(
      (one) => one.action === "accept_assignment" && one.assignmentId === producer.assignmentId,
    );
    const gate = next.actions.find(
      (one) => one.action === "run_gate" && one.assignmentId === sibling.assignmentId,
    );
    expect(accept?.rank ?? 999).toBeLessThan(gate?.rank ?? 0);
  });
});
