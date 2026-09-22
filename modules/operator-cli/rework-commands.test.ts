import { afterEach, describe, expect, test } from "bun:test";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  delegateRework,
  disposeFindings,
  grantDirection,
  makeReviewWorkspace,
  type Producer,
  reportBody,
  reportReview,
  startProducer,
  startRework,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
  herdrCalls,
  requestId as request,
  runJson,
  workspaces,
} from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const BLOCKER = {
  key: "missing-gate",
  severity: "blocker",
  summary: "The result does not state the gate it passed.",
  evidence: "docs/result.md:1",
};

const IMPROVEMENT = {
  key: "wording",
  severity: "improvement",
  summary: "The summary could name the module.",
  evidence: "docs/result.md:3",
};

/** One reviewed result with one blocker and one improvement, ready for a disposition. */
async function reviewedResult(
  workspace: Workspace,
  options: { standards?: (typeof BLOCKER)[]; spec?: (typeof BLOCKER)[] } = {},
) {
  const producer = await startProducer(workspace);
  const base = await headCommit(workspace);
  const artifact = await commitArtifact(workspace, producer, "# Result\n");
  const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
  const reported = await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({
      submissionIdentity: submitted.json.data.identity,
      host: workspace.host,
      standardsFindings: options.standards ?? [BLOCKER],
      specFindings: options.spec ?? [IMPROVEMENT],
    }),
  );

  return { producer, base, artifact, submitted, reviewer, reported };
}

type Reported = { json: { data: { findings: Array<{ key: string; findingId: string }> } } };

/** The identity one report gave the finding under this key. */
function findingId(reported: Reported, key: string): string {
  const found = reported.json.data.findings.find((one) => one.key === key);
  if (found === undefined) {
    throw new Error(`the report carries no finding under ${key}`);
  }

  return found.findingId;
}

/** Submits the combined revision of one rework cycle from its own worktree. */
async function submitRevision(
  workspace: Workspace,
  reworked: Producer & { assignmentRevision: number },
  base: string,
  text: string,
) {
  const artifact = await commitArtifact(workspace, reworked, text);
  const submitted = await submit(
    workspace,
    reworked,
    submissionBody(reworked, artifact, base, { assignmentRevision: reworked.assignmentRevision }),
  );
  return { artifact, submitted };
}

describe("operator work rework", () => {
  test("delegates accepted corrections to a fresh Operative and reviews the revision", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const first = await reviewedResult(workspace);
    const { producer, submitted, reviewer } = first;
    const gate = findingId(first.reported, "missing-gate");
    const wording = findingId(first.reported, "wording");

    const undisposed = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: first.artifact.commit,
    });
    expect(undisposed.json.reason).toBe("findings_undisposed");

    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      {
        findingId: gate,
        disposition: "corrected",
        reason: "The requirement names the gate, so the result must state it.",
      },
      {
        findingId: wording,
        disposition: "deferred",
        reason: "The wording is readable as it stands.",
        followUp: "github:operator#23",
      },
    ]);

    const pending = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: first.artifact.commit,
    });
    expect(pending.exitCode).toBe(6);
    expect(pending.json.reason).toBe("rework_pending");

    // The reviewer that found it hands its slot back before the correction is delegated.
    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });

    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        instruction: "State the gate the result passed, and keep the approved scope.",
        conflicts: [],
      },
    });
    expect(delegated.exitCode).toBe(0);
    expect(delegated.json.reason).toBe("rework_delegated");
    expect(delegated.json.data.cycleIndex).toBe(1);
    expect(delegated.json.data.limit).toBe(3);
    expect(delegated.json.data.corrections).toEqual([gate]);

    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/rework`,
    });

    // The rework runs as its own Herdr agent, never the reviewer's and never the Operator.
    const agents = (await herdrCalls(workspace))
      .filter((line) => line.startsWith("agent start "))
      .map((line) => line.split(" ")[2]);
    expect(new Set(agents).size).toBe(agents.length);

    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("## The result you rework");
    expect(brief).toContain("findings cycle 1 of 3");
    expect(brief).toContain(gate);
    expect(brief).toContain("State the gate the result passed");
    expect(brief).toContain("The Operator accepted it because:");
    // The deferred finding was answered already, so it is not delegated work.
    expect(brief).not.toContain("The summary could name the module.");
    expect(brief).toContain("The acceptance requirements above still stand.");
    // The original requirements reach the rework unchanged.
    expect(brief).toContain("- The quality gate passes.");

    const copied = await Bun.file(
      `${reworked.worktreePath}/.operator/local/rework/0-result.md`,
    ).text();
    expect(copied).toBe("# Result\n");

    const second = await submitRevision(
      workspace,
      reworked,
      first.base,
      "# Result\n\nThe quality gate passed.\n",
    );
    expect(second.submitted.json.data.reworkCycleId).toBe(delegated.json.data.cycleId);
    // A second round is a separate review assignment, so a separate reviewer takes it.
    expect(second.submitted.json.data.reviewAssignmentId).not.toBe(
      submitted.json.data.reviewAssignmentId,
    );

    const secondReviewer = await startReviewer(
      workspace,
      producer,
      second.submitted.json,
      second.artifact.commit,
    );
    const secondBrief = await Bun.file(
      `${secondReviewer.worktreePath}/.operator/local/brief.md`,
    ).text();
    expect(secondBrief).toContain("### Earlier rounds on this assignment");
    expect(secondBrief).toContain(`${gate} (standards, blocker) corrected`);
    expect(secondBrief).toContain(`${wording} (spec, improvement) deferred`);
    expect(secondBrief).toContain("Rework cycle");
    expect(secondBrief).toContain("report a finding that");

    const secondReport = await reportReview(
      workspace,
      secondReviewer,
      second.submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: second.submitted.json.data.identity,
        host: workspace.host,
      }),
    );
    expect(secondReport.json.reason).toBe("review_reported");

    const accepted = await acceptProduction(workspace, reworked, {
      submissionId: second.submitted.json.data.submissionId,
      revision: second.submitted.json.data.revision,
      prHead: second.artifact.commit,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
  });
});

describe("rework limits", () => {
  test("a fourth correction cycle waits on the user and keeps its evidence", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    let current = await startProducer(workspace);
    const base = await headCommit(workspace);
    let artifact = await commitArtifact(workspace, current, "# Result 0\n");
    let submitted = await submit(workspace, current, submissionBody(current, artifact, base));

    /** One full round: review it, accept the correction, delegate it, and rework it. */
    async function correctionRound(round: number) {
      const reviewer = await startReviewer(workspace, current, submitted.json, artifact.commit);
      const reported = await reportReview(
        workspace,
        reviewer,
        submitted.json.data.reviewId,
        reportBody({
          submissionIdentity: submitted.json.data.identity,
          host: workspace.host,
          standardsFindings: [BLOCKER],
        }),
      );
      await disposeFindings(workspace, current, submitted.json.data.reviewId, [
        {
          findingId: findingId(reported, "missing-gate"),
          disposition: "corrected",
          reason: "The requirement names the gate.",
        },
      ]);
      await acceptReview(workspace, current, {
        reviewAssignmentId: submitted.json.data.reviewAssignmentId,
        attemptId: reviewer.attemptId,
        revision: reviewer.revision,
      });

      return delegateRework(workspace, current, {
        revision: submitted.json.data.revision,
        body: {
          reason: "findings",
          reviewId: submitted.json.data.reviewId,
          instruction: `State the gate, round ${round}.`,
          conflicts: [],
        },
      });
    }

    /** The combined revision of one delegated cycle, from its own fresh worktree. */
    async function revise(delegated: { json: { data: { revision: number } } }, round: number) {
      current = await startRework(workspace, current, {
        revision: delegated.json.data.revision,
        commit: artifact.commit,
        worktreePath: `${workspace.root}/rework-${round}`,
      });
      artifact = await commitArtifact(workspace, current, `# Result ${round}\n`);
      submitted = await submit(
        workspace,
        current,
        submissionBody(current, artifact, base, {
          assignmentRevision: current.assignmentRevision,
        }),
      );
    }

    for (const round of [1, 2, 3]) {
      const delegated = await correctionRound(round);
      expect(delegated.json.data.cycleIndex).toBe(round);
      await revise(delegated, round);
    }

    const refused = await correctionRound(4);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("limit_reached");
    expect(refused.json.blockers[0]).toMatchObject({
      limitKind: "rework_cycles",
      limit: 3,
      used: 3,
    });

    const direction = refused.json.data.direction;
    expect(direction.revision).toBe(1);
    // The failure evidence is kept, not erased by the limit that stopped the work.
    expect(direction.evidence.attempted).toHaveLength(3);

    const blocked = await acceptProduction(workspace, current, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.reason).toBe("direction_required");

    // A later Operator session reads the same limit, because it lives in the crew state.
    const taken = await runJson(workspace, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "second-session",
      "--takeover",
      "--ownership-revision",
      "1",
    ]);
    current = { ...current, ownerToken: taken.json.data.ownerToken };

    const again = await delegateRework(workspace, current, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        instruction: "State the gate, round 4.",
        conflicts: [],
      },
    });
    expect(again.json.reason).toBe("limit_reached");
    expect(again.json.data.direction.directionRequestId).toBe(direction.directionRequestId);
    expect(again.json.data.direction.revision).toBe(1);

    // An approval that answers another revision of the request covers nothing.
    await grantDirection(
      workspace,
      current,
      { approval: { ...direction.approval, requestRevision: "2" } },
      "Keep going.",
    );
    const stale = await delegateRework(workspace, current, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        instruction: "State the gate, round 4.",
        conflicts: [],
      },
    });
    expect(stale.json.reason).toBe("limit_reached");

    await grantDirection(
      workspace,
      current,
      direction,
      "Run one more correction cycle, then bring it back to me.",
    );

    const directed = await delegateRework(workspace, current, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        instruction: "State the gate, round 4.",
        conflicts: [],
      },
    });
    expect(directed.exitCode).toBe(0);
    expect(directed.json.data.cycleIndex).toBe(4);
    expect(directed.json.data.approvalId).not.toBeNull();

    // The cycle the user raised the limit to is the limit its Operative is told about.
    const reworked = await startRework(workspace, current, {
      revision: directed.json.data.revision,
      commit: artifact.commit,
      worktreePath: `${workspace.root}/rework-4`,
    });
    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("findings cycle 4 of 4");
    expect(brief).toContain(
      `This cycle runs past the recorded limit under approval ${directed.json.data.approvalId}`,
    );
  }, 60_000);

  test("a third diagnostic rerun waits on the user", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    let current = await startProducer(workspace);
    const base = await headCommit(workspace);
    let artifact = await commitArtifact(workspace, current, "# Result 0\n");
    const flaky = [
      {
        name: "quality",
        command: "bun run quality",
        outcome: "flaky",
        detail: "One test failed once.",
      },
    ];
    let submitted = await submit(
      workspace,
      current,
      submissionBody(current, artifact, base, { checks: flaky }),
    );

    async function rerun(round: number) {
      const delegated = await delegateRework(workspace, current, {
        revision: submitted.json.data.revision,
        body: {
          reason: "diagnostic",
          checks: ["quality"],
          instruction: `Run the quality gate again, round ${round}.`,
          conflicts: [],
        },
      });
      if (delegated.exitCode !== 0) {
        return delegated;
      }

      current = await startRework(workspace, current, {
        revision: delegated.json.data.revision,
        commit: artifact.commit,
        worktreePath: `${workspace.root}/diagnostic-${round}`,
      });
      artifact = await commitArtifact(workspace, current, `# Result ${round}\n`);
      submitted = await submit(
        workspace,
        current,
        submissionBody(current, artifact, base, {
          assignmentRevision: current.assignmentRevision,
          checks: flaky,
        }),
      );
      return delegated;
    }

    expect((await rerun(1)).json.data.cycleIndex).toBe(1);
    const second = await rerun(2);
    expect(second.json.data.cycleIndex).toBe(2);
    expect(second.json.data.limit).toBe(2);

    const refused = await rerun(3);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("limit_reached");
    expect(refused.json.blockers[0]).toMatchObject({ limitKind: "diagnostic_reruns", limit: 2 });

    // A passing check has nothing to diagnose, so a rerun is refused before any limit.
    const passing = await delegateRework(workspace, current, {
      revision: submitted.json.data.revision,
      body: {
        reason: "diagnostic",
        checks: ["unknown-gate"],
        instruction: "Run a check that was never recorded.",
        conflicts: [],
      },
    });
    expect(passing.json.reason).toBe("unknown_check");
  }, 60_000);
});

describe("conflicts and combined revisions", () => {
  test("a revision is combined before any review reported", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    // The base moved under a result that no reviewer has read yet. Combining it first is the
    // point of an integration cycle, so it names no review.
    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "integration",
        instruction: "Combine this result with the accepted helper before anyone reviews it.",
        conflicts: [],
        combines: [{ name: "accepted helper", revision: "rev-helper-1" }],
      },
    });

    expect(delegated.exitCode).toBe(0);
    expect(delegated.json.data.reviewId).toBeNull();
    expect(delegated.json.data.corrections).toEqual([]);

    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: artifact.commit,
      worktreePath: `${workspace.root}/combined`,
    });
    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("- Review: none");
    expect(brief).toContain("- accepted helper: rev-helper-1");
  });

  test("a conflict may not name a finding the cycle does not carry", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const first = await reviewedResult(workspace, { spec: [] });
    const { producer, submitted, reviewer } = first;
    const gate = findingId(first.reported, "missing-gate");

    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      { findingId: gate, disposition: "corrected", reason: "The requirement names the gate." },
    ]);
    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });
    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        instruction: "State the gate.",
        conflicts: [],
      },
    });
    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/round-2`,
    });
    const second = await submitRevision(workspace, reworked, first.base, "# Result\n\nGated.\n");

    // The second round is not reviewed yet, so this cycle carries no correction at all.
    // A finding of the earlier round is still a finding, and naming it delegates nothing.
    const refused = await delegateRework(workspace, reworked, {
      revision: second.submitted.json.data.revision,
      body: {
        reason: "integration",
        instruction: "Combine it with the accepted helper.",
        conflicts: [{ summary: "The gate and the helper disagree.", between: [gate, "helper"] }],
        combines: [{ name: "accepted helper", revision: "rev-helper-1" }],
      },
    });
    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("conflict_not_corrected");
    expect(refused.json.blockers[0]).toMatchObject({ findingId: gate });

    // The same cycle without that conflict is ordinary combining work.
    const delegatedAgain = await delegateRework(workspace, reworked, {
      revision: second.submitted.json.data.revision,
      body: {
        reason: "integration",
        instruction: "Combine it with the accepted helper.",
        conflicts: [{ summary: "The helper and the base disagree.", between: ["helper", "base"] }],
        combines: [{ name: "accepted helper", revision: "rev-helper-1" }],
      },
    });
    expect(delegatedAgain.exitCode).toBe(0);
    expect(delegatedAgain.json.data.conflicts).toBe(1);
  }, 60_000);

  test("a reported review is answered even when the combining cycle names no review", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const first = await reviewedResult(workspace);

    // The review reported and its findings carry no disposition, so combining the result away
    // would leave them unanswered.
    const refused = await delegateRework(workspace, first.producer, {
      revision: first.submitted.json.data.revision,
      body: {
        reason: "integration",
        instruction: "Combine it with the accepted helper.",
        conflicts: [],
        combines: [{ name: "accepted helper", revision: "rev-helper-1" }],
      },
    });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("findings_undisposed");
  });

  test("a conflict is delegated and only the combined revision is reviewed", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const specBlocker = {
      key: "scope-narrower",
      severity: "blocker",
      summary: "The spec asks for the narrower behaviour.",
      evidence: "github:operator#15",
    };
    const first = await reviewedResult(workspace, { spec: [specBlocker] });
    const { producer, submitted, reviewer } = first;
    const gate = findingId(first.reported, "missing-gate");
    const scope = findingId(first.reported, "scope-narrower");

    // A conflict names work this cycle carries, so a rejected finding cannot appear in one.
    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      {
        findingId: gate,
        disposition: "rejected",
        reason: "The gate is named in the commit message.",
        evidence: "git log -1 shows the gate.",
      },
      {
        findingId: scope,
        disposition: "corrected",
        reason: "The spec is the approved source.",
      },
    ]);
    const strayConflict = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "integration",
        reviewId: submitted.json.data.reviewId,
        instruction: "Combine the narrower behaviour with the accepted helper.",
        conflicts: [{ summary: "The two axes disagree.", between: [gate, scope] }],
        combines: [{ name: "accepted helper", revision: "rev-helper-1" }],
      },
    });
    expect(strayConflict.exitCode).toBe(2);
    expect(strayConflict.json.reason).toBe("conflict_not_corrected");
    expect(strayConflict.json.blockers[0]).toMatchObject({ findingId: gate });

    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });

    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "integration",
        reviewId: submitted.json.data.reviewId,
        instruction: "Combine the narrower behaviour with the accepted helper.",
        conflicts: [
          {
            summary: "The narrower behaviour and the accepted helper disagree on the default.",
            between: [scope, "accepted helper"],
          },
        ],
        combines: [{ name: "accepted helper", revision: "rev-helper-1" }],
      },
    });
    expect(delegated.exitCode).toBe(0);
    expect(delegated.json.data.conflicts).toBe(1);

    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: first.artifact.commit,
      worktreePath: `${workspace.root}/integration`,
    });
    const brief = await Bun.file(`${reworked.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("### Conflicts to settle");
    expect(brief).toContain("disagree on the default");
    expect(brief).toContain("- accepted helper: rev-helper-1");
    expect(brief).toContain("Settle every conflict above yourself.");
    expect(brief).toContain("combined revision, then submit that one revision.");

    // The intermediate revision is not acceptable: the review that counts reads the combined one.
    const intermediate = await acceptProduction(workspace, reworked, {
      submissionId: submitted.json.data.submissionId,
      revision: reworked.assignmentRevision,
      prHead: first.artifact.commit,
    });
    expect(intermediate.json.reason).toBe("assignment_not_claimed");

    const second = await submitRevision(
      workspace,
      reworked,
      first.base,
      "# Result\n\nThe narrower behaviour, combined with the helper.\n",
    );
    const secondReviewer = await startReviewer(
      workspace,
      producer,
      second.submitted.json,
      second.artifact.commit,
    );
    const secondBrief = await Bun.file(
      `${secondReviewer.worktreePath}/.operator/local/brief.md`,
    ).text();
    // The reviewer of the combined revision reads what the earlier round settled.
    expect(secondBrief).toContain("Conflict settled by the Operative");
    expect(secondBrief).toContain(`${gate} (standards, blocker) rejected`);

    await reportReview(
      workspace,
      secondReviewer,
      second.submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: second.submitted.json.data.identity,
        host: workspace.host,
      }),
    );

    const accepted = await acceptProduction(workspace, reworked, {
      submissionId: second.submitted.json.data.submissionId,
      revision: second.submitted.json.data.revision,
      prHead: second.artifact.commit,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
  }, 60_000);
});
