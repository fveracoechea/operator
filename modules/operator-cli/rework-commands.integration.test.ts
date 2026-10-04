import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  delegateRework,
  makeReviewWorkspace,
  moveRecordedTip,
  passCandidateGate,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startRework,
  startReviewer,
  startSibling,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
  nextActions,
  pausedGit,
  requestId as request,
  runJson,
  workspaces,
} from "./workspace-fixture.ts";

// Each test runs producers, reviewers, and gate runs through separate CLI processes.
setDefaultTimeout(180_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

/** A gate that passes on the base and fails on every commit that holds the result file. */
const FAILING_GATE = {
  $schema: "./node_modules/@fveracoechea/operator/gate.schema.json",
  commands: [
    { name: "quality", argv: ["sh", "-c", "test ! -f docs/result.md"], timeoutSeconds: 30 },
  ],
};

const INTEGRATION = { reason: "integration", conflicts: [] };

/** Commits, submits, and reviews one result with no finding, so only the landing is left. */
async function reviewedResult(
  workspace: Workspace,
  producer: Producer,
  options: { text: string; round: string; path?: string },
) {
  const artifact = await commitArtifact(workspace, producer, options.text, options.path);
  const submitted = await submit(
    workspace,
    producer,
    submissionBody(producer, artifact, { assignmentRevision: producer.assignmentRevision }),
  );
  expect(submitted.json.reason).toBe("result_submitted");
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit, {
    worktreePath: `${workspace.root}/reviewer-${options.round}`,
  });
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  expect(reported.json.reason).toBe("review_reported");
  // The reviewer frees its crew slot, so a later cycle can be dispatched.
  const freed = await acceptReview(workspace, producer, {
    reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  expect(freed.json.reason).toBe("assignment_accepted");
  return {
    artifact,
    reviewer,
    submitted,
    submissionId: submitted.json.data.submissionId as string,
    reviewId: submitted.json.data.reviewId as string,
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

/** Twenty numbered lines, with the given lines changed, so two nearby changes merge cleanly. */
function numbered(changed: Record<number, string> = {}): string {
  return Array.from({ length: 20 }, (_, index) => changed[index] ?? `line ${index}`)
    .join("\n")
    .concat("\n");
}

/** A reviewed result whose landing conflicts with the recorded tip. */
async function conflictedResult(workspace: Workspace) {
  const producer = await startProducer(workspace);
  const result = await reviewedResult(workspace, producer, { text: "# Result\n", round: "1" });
  const moved = await moveRecordedTip(workspace, { path: "docs/result.md", text: "# Other\n" });
  return { producer, result, ...moved };
}

describe("an integration cycle", () => {
  test("a conflict at acceptance offers the cycle, which starts from the recorded tip", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, result, branch, tip } = await conflictedResult(workspace);

    const refused = await acceptProduction(workspace, producer, { ...result, gate: false });
    expect(refused.json.reason).toBe("landing_conflict");

    // `crew next` plans the landing to read the conflict, and it changes no ref and no file (R1).
    const seen = () =>
      Promise.all([
        Bun.$`git -C ${workspace.repo} for-each-ref`.text(),
        Bun.$`git -C ${workspace.repo} status --porcelain`.text(),
        Bun.$`git -C ${producer.worktreePath} status --porcelain`.text(),
      ]);
    const before = await seen();
    const next = await nextActions(workspace);
    expect(await seen()).toEqual(before);
    const owed = next.actions.find((one) => one.assignmentId === producer.assignmentId);
    expect(owed).toMatchObject({
      action: "delegate_rework",
      blocker: null,
      command: "operator work rework",
    });
    expect(owed?.detail).toContain("docs/result.md");
    expect(next.forAction("run_gate").map((one) => one.assignmentId)).not.toContain(
      producer.assignmentId,
    );

    // The revisions it combines are facts the CLI reads, so the input cannot name one.
    const named = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: { ...INTEGRATION, combines: [{ name: "helper", revision: "rev-helper-1" }] },
    });
    expect(named.json.reason).toBe("invalid_rework_input");

    const delegated = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    expect(delegated.json.reason).toBe("rework_delegated");
    expect(delegated.json.data).toMatchObject({ reason: "integration", reviewId: result.reviewId });

    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      producer.assignmentId,
      "--revision",
      String(delegated.json.data.revision),
    ]);
    const attemptId = claimed.json.data.attemptId as string;
    const worktreePath = `${workspace.root}/integration`;
    const dispatch = (commit: string[]) =>
      runJson(workspace, [
        "attempt",
        "dispatch",
        "--request",
        request(),
        "--owner-token",
        producer.ownerToken,
        "--attempt",
        attemptId,
        ...commit,
        "--worktree",
        worktreePath,
      ]);

    // The cycle never starts from the submitted commit, which no longer lands as reviewed.
    const fromSubmitted = await dispatch(["--commit", result.artifact.commit]);
    expect(fromSubmitted.json.reason).toBe("dispatch_base_not_tip");
    expect(fromSubmitted.json.blockers[0]).toMatchObject({ recordedTip: tip });

    const dispatched = await dispatch([]);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect(dispatched.json.data.baseCommit).toBe(tip);
    expect(await headCommit(workspace, worktreePath)).toBe(tip);
    const brief = await Bun.file(`${worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(`- submitted commit: ${result.artifact.commit}`);
    expect(brief).toContain(`- recorded tip of ${branch}: ${tip}`);
    expect(brief).toContain("- The submitted commit conflicts with the tip.");
    expect(brief).toContain("- Conflicting paths: docs/result.md");
    expect(brief).toContain(`Your worktree starts from the recorded tip of ${branch}`);
    expect(brief).not.toContain("Start from the submitted commit above");
  });

  test("the review of the new commit receives the reviewed patch and the interdiff", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, result, branch, tip } = await conflictedResult(workspace);
    const delegated = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: null,
      worktreePath: `${workspace.root}/integration`,
    });
    expect(reworked.baseCommit).toBe(tip);

    const combined = await reviewedResult(workspace, reworked, {
      text: "# Other\n\n# Result\n",
      round: "2",
    });
    const reviewerBrief = await Bun.file(
      `${combined.reviewer.worktreePath}/.operator/local/brief.md`,
    ).text();
    expect(reviewerBrief).toContain("- Reviewed patch: .operator/local/review/reviewed-patch.diff");
    expect(reviewerBrief).toContain("- Interdiff: .operator/local/review/interdiff.diff");
    const reviewedPatch = await Bun.file(
      `${combined.reviewer.worktreePath}/.operator/local/review/reviewed-patch.diff`,
    ).text();
    expect(reviewedPatch).toContain("+# Result");
    expect(reviewedPatch).not.toContain("# Other");
    const interdiff = await Bun.file(
      `${combined.reviewer.worktreePath}/.operator/local/review/interdiff.diff`,
    ).text();
    expect(interdiff).toContain("# Other");

    // The new commit is a new submission with its own review, and it lands on the tip as itself.
    const accepted = await acceptProduction(workspace, reworked, combined);
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.landing).toMatchObject({
      branch,
      from: tip,
      to: combined.artifact.commit,
    });
  });

  test("a failed candidate gate makes the cycle carry the failed run as an artifact", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { gate: FAILING_GATE });
    const producer = await startProducer(workspace);
    const result = await reviewedResult(workspace, producer, { text: "# Result\n", round: "1" });
    const gated = await passCandidateGate(workspace, producer);
    expect(gated?.json.reason).toBe("gate_run_started");
    const runId = gated?.json.data.runId as string;

    const next = await nextActions(workspace);
    const owed = next.actions.find((one) => one.assignmentId === producer.assignmentId);
    expect(owed).toMatchObject({ action: "delegate_rework", blocker: null });
    expect(owed?.detail).toContain(runId);

    const delegated = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    expect(delegated.json.reason).toBe("rework_delegated");
    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: null,
      worktreePath: `${workspace.root}/integration`,
    });
    expect(reworked.baseCommit).toBe(producer.baseCommit);

    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("- The planned commit on the tip failed the project gate.");
    expect(brief).toContain(`- Failed gate run: ${runId}.`);
    const output = `.operator/local/rework/0-quality.log`;
    expect(brief).toContain(`- gate run ${runId} quality output: ${output}`);
    expect(await Bun.file(`${reworked.worktreePath}/${output}`).exists()).toBe(true);
  });

  test("refuses when the commit would land cleanly and no failed run exists", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const result = await reviewedResult(workspace, producer, { text: "# Result\n", round: "1" });

    const pending = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    expect(pending.exitCode).not.toBe(0);
    expect(pending.json.reason).toBe("lands_cleanly");
    expect(pending.json.blockers[0]).toMatchObject({
      planned: result.artifact.commit,
      tip: producer.baseCommit,
    });

    // A passing run is no failed run either, and the refusal records nothing.
    await passCandidateGate(workspace, producer);
    const passed = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    expect(passed.json.reason).toBe("lands_cleanly");
    expect(await assignmentState(workspace, producer.assignmentId)).toBe("awaiting-review");
    const accepted = await acceptProduction(workspace, producer, { ...result, gate: false });
    expect(accepted.json.reason).toBe("assignment_accepted");
  });

  test("a fourth correction of the assignment records a direction request", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { gate: FAILING_GATE });
    let producer = await startProducer(workspace);
    let result = await reviewedResult(workspace, producer, { text: "# Result\n", round: "1" });

    // The candidate fails every time, so each cycle answers the same failure again.
    for (const round of [2, 3, 4]) {
      expect((await passCandidateGate(workspace, producer))?.json.reason).toBe("gate_run_started");
      const delegated = await delegateRework(workspace, producer, {
        revision: result.revision,
        body: INTEGRATION,
      });
      expect(delegated.json.data.cycleIndex).toBe(round - 1);
      producer = await startRework(workspace, producer, {
        revision: delegated.json.data.revision,
        commit: null,
        worktreePath: `${workspace.root}/integration-${round}`,
      });
      result = await reviewedResult(workspace, producer, {
        text: `# Result\n\nRound ${round}.\n`,
        round: String(round),
      });
    }

    expect((await passCandidateGate(workspace, producer))?.json.reason).toBe("gate_run_started");
    const fourth = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    expect(fourth.json.reason).toBe("limit_reached");
    expect(fourth.json.blockers[0]).toMatchObject({ limitKind: "rework_cycles", used: 3 });
    const next = await nextActions(workspace);
    expect(next.of("direct_limit")).toMatchObject({
      assignmentId: producer.assignmentId,
      blocker: "direction_required",
      detail: "rework_cycles reached 3. Only the user can direct it.",
    });
  });

  test("a changed patch at the landing offers the cycle", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      files: { "docs/notes.md": numbered() },
    });
    const producer = await startProducer(workspace);
    const result = await reviewedResult(workspace, producer, {
      text: numbered({ 5: "line 5, changed" }),
      round: "1",
      path: "docs/notes.md",
    });
    // A change two lines away merges cleanly, but it changes the context of the reviewed patch.
    await moveRecordedTip(workspace, {
      path: "docs/notes.md",
      text: numbered({ 7: "line 7, changed on the branch" }),
    });

    const next = await nextActions(workspace);

    const owed = next.actions.find((one) => one.assignmentId === producer.assignmentId);
    expect(owed).toMatchObject({ action: "delegate_rework", blocker: null });
    expect(owed?.detail).toContain("as another patch");
    const delegated = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    expect(delegated.json.reason).toBe("rework_delegated");
  });

  test("a flaky candidate gate offers the cycle, which names the flaky run", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: {
        ...FAILING_GATE,
        commands: [
          {
            name: "quality",
            // The candidate fails until the flag exists, so a second run passes.
            argv: ["sh", "-c", "test ! -f docs/result.md || test -f ../flag"],
            timeoutSeconds: 30,
          },
        ],
      },
    });
    const producer = await startProducer(workspace);
    const result = await reviewedResult(workspace, producer, { text: "# Result\n", round: "1" });
    const failed = await passCandidateGate(workspace, producer);
    expect(failed?.json.reason).toBe("gate_run_started");
    await Bun.write(`${workspace.root}/flag`, "");
    const passed = await runJson(workspace, [
      "gate",
      "run",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      producer.assignmentId,
    ]);
    expect(passed.json.reason).toBe("gate_run_started");

    const next = await nextActions(workspace);

    const owed = next.actions.find((one) => one.assignmentId === producer.assignmentId);
    expect(owed).toMatchObject({ action: "delegate_rework", blocker: null });
    expect(owed?.detail).toContain("is flaky in gate run");
    const delegated = await delegateRework(workspace, producer, {
      revision: result.revision,
      body: INTEGRATION,
    });
    expect(delegated.json.reason).toBe("rework_delegated");
    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: null,
      worktreePath: `${workspace.root}/integration`,
    });
    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("- The planned commit on the tip is flaky at the project gate.");
  });

  test("refuses with landing_tip_changed when the tip moved after the evidence was read", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { producer, result, tip } = await conflictedResult(workspace);
    const pause = await pausedGit(workspace);

    // The cycle reads its evidence on one tip, and it stops before the transaction checks it.
    const stale = runJson(
      workspace,
      [
        "work",
        "rework",
        "--request",
        request(),
        "--owner-token",
        producer.ownerToken,
        "--assignment",
        producer.assignmentId,
        "--revision",
        String(result.revision),
        "--input",
        await writeInput(workspace, INTEGRATION),
      ],
      workspace.repo,
      pause.env,
    );
    await pause.reached();
    const moved = await moveRecordedTip(workspace, {
      path: "docs/result.md",
      text: "# Other, again\n",
    });
    await pause.release();
    const refused = await stale;

    expect(refused.json.reason).toBe("landing_tip_changed");
    expect(refused.json.blockers).toEqual([
      {
        reason: "landing_tip_changed",
        assignmentId: producer.assignmentId,
        planned: tip,
        recordedTip: moved.tip,
      },
    ]);
    expect(Object.keys(refused.json.blockers[0])).toEqual([
      "reason",
      "assignmentId",
      "planned",
      "recordedTip",
    ]);
    // The refusal names the tip the evidence was read on and the recorded tip now.
    expect(refused.stdout).toContain(tip);
    expect(refused.stdout).toContain(moved.tip);
    expect(await assignmentState(workspace, producer.assignmentId)).toBe("awaiting-review");
  });

  test("a failed candidate holds only its own assignment and the dependents that wait for it", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { gate: FAILING_GATE });
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        {
          key: "22.2",
          kind: "production",
          title: "Write the notes",
          dependsOn: [],
          writePaths: ["notes/"],
        },
        { key: "22.3", kind: "production", title: "Use the result", writePaths: ["extra/"] },
      ],
    });
    const sibling = await startSibling(workspace, producer, "22.2");
    const dependent = producer.dependents.get("22.3") ?? "";
    await reviewedResult(workspace, producer, { text: "# Result\n", round: "1" });
    await reviewedResult(workspace, sibling, {
      text: "# Notes\n",
      round: "2",
      path: "notes/notes.md",
    });
    expect((await passCandidateGate(workspace, producer))?.json.reason).toBe("gate_run_started");
    expect((await passCandidateGate(workspace, sibling))?.json.reason).toBe("gate_run_started");

    const next = await nextActions(workspace);

    expect(next.actions.find((one) => one.assignmentId === producer.assignmentId)).toMatchObject({
      action: "delegate_rework",
    });
    // The sibling does not wait on the failed candidate, so its own landing is still offered.
    expect(next.actions.find((one) => one.assignmentId === sibling.assignmentId)).toMatchObject({
      action: "accept_assignment",
    });
    expect(next.actions.filter((one) => one.assignmentId === dependent)).toEqual([]);
    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(
      (frontier.json.data.blocked as Array<{ assignmentId: string }>).map(
        (one) => one.assignmentId,
      ),
    ).toContain(dependent);
  });
});
