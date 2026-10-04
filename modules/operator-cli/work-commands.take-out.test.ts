import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { issueKey, sourceIdOf, withdrawIssues, workspaceTarget } from "./source-fixture.ts";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  invalidateResult,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  startSibling,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";
import {
  nextActions,
  requestId as request,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";

// Each test lands several results and takes one out through separate CLI processes.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 240_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const SOURCE = sourceIdOf(15);
const NOTES = { key: "22.2", kind: "production" as const, title: "Write the notes" };
const OTHER = { key: "22.3", kind: "production" as const, title: "Write the other file" };

async function branchOf(workspace: Workspace): Promise<string> {
  const format = "--format=%(refname:short)";
  const listed =
    await Bun.$`git -C ${workspace.repo} for-each-ref ${format} refs/heads/operator/integration/`.text();
  return listed.trim().split("\n")[0] ?? "";
}

/** The commits of the branch from its base, oldest first. */
async function commitsOf(workspace: Workspace, branch: string, base: string): Promise<string[]> {
  const listed =
    await Bun.$`git -C ${workspace.repo} rev-list --reverse --first-parent ${`${base}..refs/heads/${branch}`}`.text();
  return listed.trim().split("\n").filter(Boolean);
}

async function patchOf(workspace: Workspace, commit: string): Promise<string> {
  return Bun.$`git -C ${workspace.repo} diff-tree -p --no-renames ${commit}^ ${commit}`.text();
}

async function movesOf(workspace: Workspace, branch: string): Promise<number> {
  const listed =
    await Bun.$`git -C ${workspace.repo} reflog show --format=%H ${`refs/heads/${branch}`}`.text();
  return listed.trim().split("\n").length;
}

/** Commits, submits, and reviews one result, and leaves its acceptance to the caller. */
async function reviewResult(
  workspace: Workspace,
  producer: Producer,
  options: { text: string; path: string },
) {
  const artifact = await commitArtifact(workspace, producer, options.text, options.path);
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact, { assignmentRevision: producer.assignmentRevision }),
  );
  expect(submitted.json.reason).toBe("result_submitted");
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit, {
    worktreePath: `${workspace.root}/reviewer-${crypto.randomUUID().slice(0, 8)}`,
  });
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  expect(reported.json.reason).toBe("review_reported");
  await acceptReview(workspace, producer, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  return {
    artifact,
    submissionId: submitted.json.data.submissionId as string,
    revision: submitted.json.data.revision as number,
  };
}

async function landResult(
  workspace: Workspace,
  producer: Producer,
  options: { text: string; path: string },
) {
  const reviewed = await reviewResult(workspace, producer, options);
  const accepted = await acceptProduction(workspace, producer, reviewed);
  expect(accepted.json.reason).toBe("assignment_accepted");
  return { ...reviewed, accepted };
}

/** Ten numbered lines, with the named lines changed. */
function lines(changed: Record<number, string>): string {
  return Array.from({ length: 10 }, (_, index) => changed[index] ?? `line ${index}`)
    .join("\n")
    .concat("\n");
}

async function frontierOf(workspace: Workspace) {
  return (await runJson(workspace, ["work", "frontier"])).json.data;
}

async function frontierRow(workspace: Workspace, assignmentId: string) {
  const all = Object.values(await frontierOf(workspace)).flatMap((one) =>
    Array.isArray(one)
      ? (one as Array<{ assignmentId: string; state: string; revision: number }>)
      : [],
  );
  return all.find((one) => one.assignmentId === assignmentId) ?? null;
}

async function assignmentState(workspace: Workspace, assignmentId: string) {
  return (await frontierRow(workspace, assignmentId))?.state ?? null;
}

/** Withdraws one item through the tracker, as a person does, and returns the plan it recorded. */
async function withdraw(workspace: Workspace, producer: Producer, number: number) {
  const { plan, registered } = await withdrawIssues(
    workspaceTarget(workspace),
    producer.ownerToken,
    { sourceKind: "specification", parent: 15, numbers: [number] },
  );
  const file = await Bun.file(`${workspace.repo}/${plan.json.data.planPath}`).json();
  return { plan, registered, file, planRevision: plan.json.data.planRevision as string };
}

function takeOut(workspace: Workspace, producer: Producer, planRevision: string) {
  return runJson(workspace, [
    "work",
    "take-out",
    "--request",
    request(),
    "--owner-token",
    producer.ownerToken,
    "--source",
    SOURCE,
    "--plan-revision",
    planRevision,
  ]);
}

/** Runs every gate run that `crew next` owes for the take-out of the source. */
async function passTakeOutGate(workspace: Workspace, producer: Producer) {
  let runs = 0;
  for (let round = 0; round < 10; round += 1) {
    const owed = (await nextActions(workspace))
      .forAction("run_gate")
      .find((one) => one.sourceId === SOURCE && one.assignmentId === null);
    if (owed === undefined) {
      return runs;
    }
    expect(owed.command).toBe(`operator gate run --source ${SOURCE}`);
    const started = await runJson(workspace, [
      "gate",
      "run",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--source",
      SOURCE,
    ]);
    expect(started.json.reason).toBe("gate_run_started");
    runs += 1;
  }
  return runs;
}

/**
 * Each started assignment of the source whose write paths a grant of `paths` to one assignment
 * would overlap. It reads the same hold rule as the frontier.
 */
async function overlapsOf(workspace: Workspace, assignmentId: string, paths: string[]) {
  const shown = await runJson(workspace, [
    "work",
    "write-paths",
    "--assignment",
    assignmentId,
    "--input",
    await writeInput(workspace, { paths }),
  ]);
  return (shown.json.data.grant.overlaps as Array<{ assignmentId: string }>).map(
    (one) => one.assignmentId,
  );
}

function statePath(workspace: Workspace): string {
  return `${workspace.repo}/.operator/local/crew-state.sqlite`;
}

/** Records a verified tracker step of one assignment, as an earlier release did at acceptance. */
function recordEarlierStep(workspace: Workspace, assignmentId: string): void {
  const sqlite = new Database(statePath(workspace), { readwrite: true });
  const at = new Date().toISOString();
  sqlite
    .query(
      `insert into tracker_operations (id, assignment_id, step, provider, target, expected_actor,
         intent, intent_identity, close_reason, state, reason, problems, revision, created_at,
         updated_at)
       values (?, ?, 'completion', 'github', '{}', 'operator-bot', '{}', 'intent', 'completed',
         'verified', 'tracker.completed', '[]', 1, ?, ?)`,
    )
    .run(crypto.randomUUID(), assignmentId, at, at);
  sqlite.close();
}

function forgetSteps(workspace: Workspace, assignmentId: string): void {
  const sqlite = new Database(statePath(workspace), { readwrite: true });
  sqlite.query("delete from tracker_operations where assignment_id = ?").run(assignmentId);
  sqlite.close();
}

describe("operator work take-out takes the commits of withdrawn work out of the branch", () => {
  test("a take-out moves the branch once, removes the withdrawn commit, and lands each later one again", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { ...NOTES, dependsOn: [], writePaths: ["notes/"] },
        { ...OTHER, dependsOn: [], writePaths: ["other/"] },
      ],
    });
    const branch = await branchOf(workspace);
    await landResult(workspace, producer, { text: "# Result\n", path: "docs/result.md" });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const other = await startSibling(workspace, producer, OTHER.key);
    await landResult(workspace, other, { text: "# Other\n", path: "other/other.md" });
    const before = await commitsOf(workspace, branch, producer.baseCommit);
    expect(before).toHaveLength(3);

    const { registered, file, planRevision } = await withdraw(workspace, producer, 1502);

    expect(registered.json.reason).toBe("work_registered");
    // The plan lists the recorded landing and each later commit that the take-out rebuilds.
    expect(file.withdrawals).toEqual([
      {
        key: issueKey(1502),
        assignmentId: notes.assignmentId,
        state: "accepted",
        landing: before[1],
        rebuilds: [before[2]],
      },
    ]);
    // The withdrawn commit is still on the branch, so its head is not final.
    expect(registered.json.data.branchReview).toBeNull();
    // The withdrawn item holds its write paths until the take-out moves the branch (ADR 0004).
    expect(await overlapsOf(workspace, other.assignmentId, ["notes/"])).toEqual([
      notes.assignmentId,
    ]);

    // The take-out refuses until each commit of the rebuilt range passed the gate.
    const early = await takeOut(workspace, producer, planRevision);
    expect(early.json.reason).toBe("gate_pending");
    const pending = early.json.blockers[0];
    expect(Object.keys(pending)).toEqual([
      "reason",
      "assignmentId",
      "gate",
      "commit",
      "tip",
      "key",
      "runIds",
    ]);
    const earlyText = await runOperator(workspace, [
      "work",
      "take-out",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--source",
      SOURCE,
      "--plan-revision",
      planRevision,
    ]);
    // A take-out names the gate run of its source, not of an assignment.
    expect(earlyText.stdout).toBe(
      [
        `The planned commit ${pending.commit} on tip ${pending.tip} has not passed the project gate.`,
        "No gate run is recorded at its key. Run `operator gate run --source <id>` first.",
        "Nothing was taken out.",
        "",
      ].join("\n"),
    );
    expect(pending).toMatchObject({ assignmentId: notes.assignmentId, tip: before[0] });
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual(before);
    expect(await passTakeOutGate(workspace, producer)).toBe(1);

    const offered = (await nextActions(workspace)).of("take_out_commit");
    expect(offered).toMatchObject({
      sourceId: SOURCE,
      blocker: null,
      command: `operator work take-out --source ${SOURCE} --plan-revision ${planRevision}`,
    });

    // The take-out is bound to the plan revision that recorded the withdrawal (D5).
    const unbound = await takeOut(workspace, producer, "another-revision");
    expect(unbound.json.reason).toBe("take_out_plan_changed");
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual(before);

    const checkouts = [producer, notes, other].map((one) => one.worktreePath);
    const status = () =>
      Promise.all(
        [workspace.repo, ...checkouts].map((one) => Bun.$`git -C ${one} status --porcelain`.text()),
      );
    const untouched = await status();
    const moved = await movesOf(workspace, branch);

    const taken = await takeOut(workspace, producer, planRevision);

    expect(taken.json.reason).toBe("commits_taken_out");
    // The CLI moves a ref that it built only from reviewed patches, and it writes no file (R1, D5).
    expect(await status()).toEqual(untouched);
    const after = await commitsOf(workspace, branch, producer.baseCommit);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[2]);
    expect(await patchOf(workspace, after[1] ?? "")).toBe(
      await patchOf(workspace, before[2] ?? ""),
    );
    // The branch moved once, from the old tip to the rebuilt tip.
    expect(await movesOf(workspace, branch)).toBe(moved + 1);
    expect(taken.json.data).toMatchObject({
      sourceId: SOURCE,
      planRevision,
      from: before[2],
      to: after[1],
      removed: [{ assignmentId: notes.assignmentId, commit: before[1] }],
      relanded: [{ assignmentId: other.assignmentId, from: before[2], to: after[1] }],
      takenOut: [],
    });
    // The take-out made the branch final, so it registered the branch review in the same change.
    expect(taken.json.data.branchReview.headCommit).toBe(after[1]);
    expect(await overlapsOf(workspace, other.assignmentId, ["notes/"])).toEqual([]);

    const next = await nextActions(workspace);
    expect(next.names).not.toContain("take_out_commit");
    expect(next.names).not.toContain("settle_landing");
    // The withdrawn commit is on no branch now, and its checkout stays until a person removes it (R3).
    await runJson(workspace, [
      "cleanup",
      "close",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      notes.attemptId,
    ]);
    const kept = await runJson(workspace, [
      "cleanup",
      "remove",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      notes.attemptId,
    ]);
    expect(kept.json.blockers).toEqual([
      {
        reason: "unlanded_work",
        assignmentId: notes.assignmentId,
        cause: "withdrawn",
        commits: [before[1]],
      },
    ]);
    const again = await takeOut(workspace, producer, planRevision);
    expect(again.json.reason).toBe("nothing_to_take_out");
  });

  test("a later accepted commit whose patch changes returns to awaiting review, and the frontier waits", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 12 });
    const LATER = { key: "22.4", kind: "production" as const, title: "Write later" };
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { key: "22.2", kind: "production", title: "Change the result", writePaths: ["docs/"] },
        { key: "22.3", kind: "production", title: "Change it again", writePaths: ["docs/"] },
        { ...LATER, dependsOn: [], writePaths: ["later/"] },
      ],
    });
    const branch = await branchOf(workspace);
    await landResult(workspace, producer, { text: lines({}), path: "docs/result.md" });
    const changer = await startSibling(workspace, producer, "22.2");
    await landResult(workspace, changer, {
      text: lines({ 2: "changed two" }),
      path: "docs/result.md",
    });
    const user = await startSibling(workspace, producer, "22.3");
    await landResult(workspace, user, {
      text: lines({ 2: "changed two", 5: "changed five" }),
      path: "docs/result.md",
    });
    const before = await commitsOf(workspace, branch, producer.baseCommit);
    const later = producer.dependents.get(LATER.key) ?? "";
    expect(
      (await frontierOf(workspace)).dispatchable.map(
        (one: { assignmentId: string }) => one.assignmentId,
      ),
    ).toContain(later);

    const { registered, planRevision } = await withdraw(workspace, producer, 1502);
    expect(registered.json.reason).toBe("work_registered");

    // While the take-out waits, the frontier offers no production work of the source.
    const waiting = await frontierOf(workspace);
    expect(
      waiting.blocked.find((one: { assignmentId: string }) => one.assignmentId === later),
    ).toMatchObject({
      blockers: [
        {
          reason: "take_out_pending",
          commits: [{ assignmentId: changer.assignmentId, commit: before[1] }],
        },
      ],
    });

    // A tracker step that ran for a result before it is taken out holds the take-out (#114).
    recordEarlierStep(workspace, user.assignmentId);
    const held = await takeOut(workspace, producer, planRevision);
    expect(held.json.reason).toBe("rewrite_tracker_recorded");
    expect(held.json.blockers[0]).toMatchObject({
      steps: [{ assignmentId: user.assignmentId, step: "completion", state: "verified" }],
    });
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual(before);
    forgetSteps(workspace, user.assignmentId);

    // Nothing lands again, so no gate run is owed before the take-out.
    expect((await nextActions(workspace)).of("take_out_commit").blocker).toBeNull();
    // A gate run on a range with no commit to gate starts nothing, and it names no tree.
    const gateArgs = ["gate", "run", "--owner-token", producer.ownerToken, "--source", SOURCE];
    const nothing = await runJson(workspace, [...gateArgs, "--request", request()]);
    expect(nothing.json).toMatchObject({ outcome: "conflict", reason: "gate_passed" });
    expect(nothing.json.blockers).toEqual([
      {
        reason: "gate_passed",
        commit: before[0],
        tree: "",
        declarationIdentity: expect.any(String),
        runIds: [],
      },
    ]);
    const nothingText = await runOperator(workspace, [...gateArgs, "--request", request()]);
    expect(nothingText.stdout).toContain(
      `The key of commit ${before[0]} already passed in gate run . Nothing was started.`,
    );
    const taken = await takeOut(workspace, producer, planRevision);

    expect(taken.json.reason).toBe("commits_taken_out");
    expect(taken.json.data.takenOut).toEqual([
      { assignmentId: user.assignmentId, commit: before[2], cause: "patch-changed" },
    ]);
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual([before[0] ?? ""]);
    // No correction comes to release a pause, so the result returns to awaiting review.
    expect(await assignmentState(workspace, user.assignmentId)).toBe("awaiting-review");
    const next = await nextActions(workspace);
    expect(next.actions.find((one) => one.assignmentId === user.assignmentId)).toMatchObject({
      action: "delegate_rework",
      command: "operator work rework",
    });
    expect(
      (await frontierOf(workspace)).dispatchable.map(
        (one: { assignmentId: string }) => one.assignmentId,
      ),
    ).toContain(later);
  });

  test("a later result that needs the withdrawn one is taken out, and an invalidated one keeps its state", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 12 });
    const NEEDS = { key: "22.4", kind: "production" as const, title: "Read the change" };
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { key: "22.2", kind: "production", title: "Change the result", writePaths: ["docs/"] },
        { key: "22.3", kind: "production", title: "Change it again", writePaths: ["docs/"] },
        { ...NEEDS, dependsOn: [], writePaths: ["later/"] },
      ],
    });
    const branch = await branchOf(workspace);
    await landResult(workspace, producer, { text: lines({}), path: "docs/result.md" });
    const changer = await startSibling(workspace, producer, "22.2");
    await landResult(workspace, changer, {
      text: lines({ 2: "changed two" }),
      path: "docs/result.md",
    });
    const user = await startSibling(workspace, producer, "22.3");
    await landResult(workspace, user, {
      text: lines({ 2: "changed two", 5: "changed five" }),
      path: "docs/result.md",
    });
    const reader = await startSibling(workspace, producer, NEEDS.key);
    await landResult(workspace, reader, { text: "# Later\n", path: "later/later.md" });
    const before = await commitsOf(workspace, branch, producer.baseCommit);
    expect(before).toHaveLength(4);

    // A defect in 22.3 is found after it landed, so it is no longer accepted.
    const invalidated = await invalidateResult(workspace, user, {
      assignmentId: user.assignmentId,
      revision: (await frontierRow(workspace, user.assignmentId))?.revision ?? 0,
      defect: {
        summary: "The second change drops a line.",
        evidence: "docs/result.md:5.",
        foundBy: "the Operative on 22.4",
      },
    });
    expect(invalidated.json.reason).toBe("result_invalidated");
    const invalid = await assignmentState(workspace, user.assignmentId);
    expect(invalid).not.toBe("accepted");

    const { planRevision, registered } = await withdraw(workspace, producer, 1502);
    expect(registered.json.reason).toBe("work_registered");
    // Registration refuses a withdrawal while a dependent waits, so 22.4 gets its link to 22.2
    // only now, as an older record could hold it. The take-out still takes it out.
    const sqlite = new Database(statePath(workspace), { readwrite: true });
    sqlite
      .query("insert into assignment_dependencies (assignment_id, depends_on_id) values (?, ?)")
      .run(reader.assignmentId, changer.assignmentId);
    sqlite.close();
    const taken = await takeOut(workspace, producer, planRevision);

    expect(taken.json.reason).toBe("commits_taken_out");
    // 22.4 lands again with an equal patch, but it needs the withdrawn 22.2, so it is taken out.
    expect(taken.json.data.takenOut).toEqual([
      { assignmentId: user.assignmentId, commit: before[2], cause: "patch-changed" },
      { assignmentId: reader.assignmentId, commit: before[3], cause: "dependency" },
    ]);
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual([before[0] ?? ""]);
    expect(await assignmentState(workspace, reader.assignmentId)).toBe("awaiting-review");
    // A later commit that is not accepted keeps its state.
    expect(await assignmentState(workspace, user.assignmentId)).toBe(invalid);
  });

  test("an interrupted take-out is settled by a repeat that moves the branch once", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [{ ...NOTES, dependsOn: [], writePaths: ["notes/"] }],
    });
    const branch = await branchOf(workspace);
    await landResult(workspace, producer, { text: "# Result\n", path: "docs/result.md" });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const before = await commitsOf(workspace, branch, producer.baseCommit);
    const { planRevision } = await withdraw(workspace, producer, 1502);
    const moved = await movesOf(workspace, branch);
    // A lock file stops every ref write of Git, so the move fails after its intent is recorded.
    const lock = `${workspace.repo}/.git/refs/heads/${branch}.lock`;
    await Bun.write(lock, "");

    const stopped = await takeOut(workspace, producer, planRevision);

    expect(stopped.json.reason).toBe("integration_branch_unread");
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual(before);
    const settle = (await nextActions(workspace)).of("settle_landing");
    expect(settle).toMatchObject({
      sourceId: SOURCE,
      command: `operator work take-out --source ${SOURCE} --plan-revision ${planRevision}`,
    });
    // A checkout of the source proves nothing while the take-out moves the branch.
    await runJson(workspace, [
      "cleanup",
      "close",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      producer.attemptId,
    ]);
    const held = await runJson(workspace, [
      "cleanup",
      "remove",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      producer.attemptId,
    ]);
    expect(held.json.blockers.map((one: { reason: string }) => one.reason)).toEqual([
      "rewrite_pending",
    ]);

    await Bun.$`rm ${lock}`;
    const settled = await takeOut(workspace, producer, planRevision);

    expect(settled.json.reason).toBe("commits_taken_out");
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual([before[0] ?? ""]);
    expect(await movesOf(workspace, branch)).toBe(moved + 1);
    expect((await nextActions(workspace)).names).not.toContain("settle_landing");
  });

  test("a landing of the source waits for the take-out, and lands on the new tip after it", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { ...NOTES, dependsOn: [], writePaths: ["notes/"] },
        { ...OTHER, dependsOn: [], writePaths: ["other/"] },
      ],
    });
    const branch = await branchOf(workspace);
    await landResult(workspace, producer, { text: "# Result\n", path: "docs/result.md" });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const other = await startSibling(workspace, producer, OTHER.key);
    const reviewed = await reviewResult(workspace, other, {
      text: "# Other\n",
      path: "other/other.md",
    });
    const before = await commitsOf(workspace, branch, producer.baseCommit);

    const { planRevision } = await withdraw(workspace, producer, 1502);

    // crew next offers the take-out ahead of the landing, and acceptance refuses until it ran.
    const next = await nextActions(workspace);
    expect(next.names).toContain("take_out_commit");
    const landings = ["accept_assignment", "run_gate", "delegate_rework"];
    expect(
      next.actions.filter(
        (one) => one.assignmentId === other.assignmentId && landings.includes(one.action),
      ),
    ).toEqual([]);
    const refused = await acceptProduction(workspace, other, { ...reviewed, gate: false });
    expect(refused.json.reason).toBe("take_out_pending");
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual(before);
    // A second withdrawal of landed work waits until the first take-out ran.
    const second = await withdraw(workspace, producer, 1501);
    expect(second.file.refusals).toContainEqual({
      reason: "take_out_pending",
      key: issueKey(1501),
      assignmentId: producer.assignmentId,
      pending: [notes.assignmentId],
    });

    const taken = await takeOut(workspace, producer, planRevision);

    expect(taken.json.reason).toBe("commits_taken_out");
    expect(taken.json.data).toMatchObject({ relanded: [], takenOut: [] });
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual([before[0] ?? ""]);
    expect(await assignmentState(workspace, other.assignmentId)).toBe("awaiting-review");
    // Its landing is an ordinary landing on the new tip.
    const accepted = await acceptProduction(workspace, other, reviewed);
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.landing.from).toBe(before[0]);
  });

  test("a take-out whose recorded landings do not lead to the base refuses and records nothing", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [{ ...NOTES, dependsOn: [], writePaths: ["notes/"] }],
    });
    const branch = await branchOf(workspace);
    await landResult(workspace, producer, { text: "# Result\n", path: "docs/result.md" });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const before = await commitsOf(workspace, branch, producer.baseCommit);
    const { planRevision } = await withdraw(workspace, producer, 1502);
    // The lowest landing names a parent that no landing and no base holds, so the chain breaks.
    const setParent = (parent: string) => {
      const sqlite = new Database(statePath(workspace), { readwrite: true });
      sqlite
        .query("update landings set landed_parent = ? where landed_commit = ?")
        .run(parent, before[0] ?? "");
      sqlite.close();
    };
    setParent("0".repeat(40));
    const moved = await movesOf(workspace, branch);

    const refused = await takeOut(workspace, producer, planRevision);

    expect(refused.json.reason).toBe("integration_branch_unread");
    expect(refused.json.outcome).toBe("uncertain");
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual(before);
    expect(await movesOf(workspace, branch)).toBe(moved);
    expect(await assignmentState(workspace, notes.assignmentId)).toBe("withdrawn");

    // Nothing was recorded, so the take-out runs once the record leads to the base again.
    setParent(producer.baseCommit);
    expect(await passTakeOutGate(workspace, producer)).toBe(0);
    const taken = await takeOut(workspace, producer, planRevision);
    expect(taken.json.reason).toBe("commits_taken_out");
    expect(await commitsOf(workspace, branch, producer.baseCommit)).toEqual([before[0] ?? ""]);
  });

  // A named departure of #133: before, crew next printed a take-out command with an empty plan
  // revision and the take-out went on. Every withdrawal records its plan revision, so only a
  // damaged state file gets here, and now crew next and the take-out stop on it.
  test("a withdrawn assignment that records no plan revision stops crew next and the take-out", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [{ ...NOTES, dependsOn: [], writePaths: ["notes/"] }],
    });
    await landResult(workspace, producer, { text: "# Result\n", path: "docs/result.md" });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const { planRevision } = await withdraw(workspace, producer, 1502);
    const sqlite = new Database(statePath(workspace), { readwrite: true });
    sqlite
      .query("update assignments set withdrawn_under = null where id = ?")
      .run(notes.assignmentId);
    sqlite.close();
    const broken = `Withdrawn assignment ${notes.assignmentId} records no plan revision.`;

    const next = await runOperator(workspace, ["crew", "next", "--claude", "--json"]);
    expect(next.exitCode).not.toBe(0);
    expect(next.stdout + next.stderr).toContain(broken);

    const taken = await runOperator(workspace, [
      "work",
      "take-out",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--source",
      SOURCE,
      "--plan-revision",
      planRevision,
      "--json",
    ]);
    expect(taken.exitCode).not.toBe(0);
    expect(taken.stdout + taken.stderr).toContain(broken);
  });
});

describe("one gate run of a source runs at a time", () => {
  /** Holds each gate run that a pane starts, so it stays running and its runner shows. */
  async function holdRuns(workspace: Workspace) {
    await Bun.write(`${workspace.herdr}/pane-run.hold`, "");
  }

  function gateRun(workspace: Workspace, producer: Producer, subject: string[]) {
    return runJson(workspace, [
      "gate",
      "run",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      ...subject,
    ]);
  }

  test("a second gated move of the source waits while a gate run of the source runs", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { ...NOTES, dependsOn: [], writePaths: ["notes/"] },
        { ...OTHER, dependsOn: [], writePaths: ["other/"] },
      ],
    });
    await landResult(workspace, producer, { text: "# Result\n", path: "docs/result.md" });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await reviewResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const other = await startSibling(workspace, producer, OTHER.key);
    await reviewResult(workspace, other, { text: "# Other\n", path: "other/other.md" });
    const owed = (await nextActions(workspace)).forAction("run_gate");
    expect(owed.map((one) => one.assignmentId).toSorted()).toEqual(
      [notes.assignmentId, other.assignmentId].toSorted(),
    );

    await holdRuns(workspace);
    const started = await gateRun(workspace, producer, ["--assignment", notes.assignmentId]);
    expect(started.json.reason).toBe("gate_run_started");
    const { runId } = started.json.data;

    const next = await nextActions(workspace);
    expect(next.forAction("run_gate")).toEqual([]);
    const waits = next.waits.filter(
      (one) => one.wait === "gate_running" && one.assignmentId === other.assignmentId,
    );
    expect(waits.map((one) => one.detail)).toEqual([
      `Gate run ${runId} of source ${SOURCE} runs first. One gate run of a source runs at a time.`,
    ]);
  });

  test("a gate run of a take-out whose place still runs names the run and its commit", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 8 });
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        { ...NOTES, dependsOn: [], writePaths: ["notes/"] },
        { ...OTHER, dependsOn: [], writePaths: ["other/"] },
      ],
    });
    await landResult(workspace, producer, { text: "# Result\n", path: "docs/result.md" });
    const notes = await startSibling(workspace, producer, NOTES.key);
    await landResult(workspace, notes, { text: "# Notes\n", path: "notes/notes.md" });
    const other = await startSibling(workspace, producer, OTHER.key);
    await landResult(workspace, other, { text: "# Other\n", path: "other/other.md" });
    await withdraw(workspace, producer, 1502);

    await holdRuns(workspace);
    const started = await gateRun(workspace, producer, ["--source", SOURCE]);
    expect(started.json.reason).toBe("gate_run_started");
    const { runId } = started.json.data;
    await Bun.write(
      `${workspace.herdr}/pane-processes`,
      `200|bun|bun cli.ts gate runner --run ${runId}\n`,
    );
    const shown = await runJson(workspace, ["gate", "show", "--run", runId]);
    const { commit } = shown.json.data;

    const refused = await gateRun(workspace, producer, ["--source", SOURCE]);
    expect(refused.json).toMatchObject({ reason: "gate_running", blockers: [{ runId }] });
    const human = await runOperator(workspace, [
      "gate",
      "run",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--source",
      SOURCE,
    ]);
    expect(human.stdout).toContain(
      `Gate run ${runId} still runs at commit ${commit} of the rebuilt range.\nOne gate run of a source runs at a time. Wait for its outcome.\n`,
    );
  });
});
