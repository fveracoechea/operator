import { afterEach, describe, expect, test } from "bun:test";
import {
  commitArtifact,
  disposeFindings,
  makeReviewWorkspace,
  registerDependents,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
  markFakeAgent,
  requestId as request,
  runJson,
  stopFakeAgents,
  workspaces,
} from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

type Action = {
  action: string;
  rank: number;
  assignmentId: string | null;
  attemptId: string | null;
  questionId: string | null;
  reviewId: string | null;
  revision: number | null;
  needsUser: boolean;
  command: string;
};

type Wait = { wait: string; assignmentId: string; attemptId: string; agentName: string | null };

async function next(workspace: Workspace) {
  const result = await runJson(workspace, ["crew", "next", "--claude"]);
  const actions: Action[] = result.json.data.actions;
  const waits: Wait[] = result.json.data.waits ?? [];
  return {
    ...result,
    actions,
    waits,
    names: actions.map((one) => one.action),
    of(name: string): Action {
      const found = actions.find((one) => one.action === name);
      if (found === undefined) {
        throw new Error(`the next actions carry no ${name}: ${actions.map((o) => o.action)}`);
      }
      return found;
    },
  };
}

async function own(workspace: Workspace, label: string, revision: number): Promise<string> {
  const taken = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    label,
    "--takeover",
    "--ownership-revision",
    String(revision),
  ]);
  return taken.json.data.ownerToken;
}

async function adopt(workspace: Workspace, ownerToken: string, attemptId: string) {
  return runJson(workspace, [
    "attempt",
    "adopt",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--attempt",
    attemptId,
  ]);
}

/** One question raised by the Operative that holds an attempt. */
async function raise(
  workspace: Workspace,
  attempt: { attemptId: string; worktreePath: string },
  escalationTriggers: string[] = [],
) {
  const path = `${workspace.root}/question-${crypto.randomUUID()}.json`;
  await Bun.write(
    path,
    JSON.stringify({
      question: "Does the export keep the legacy column order?",
      evidence: [{ label: "ticket", detail: "The ticket states a new order." }],
      options: [{ name: "keep", detail: "Keep the legacy order.", risk: "The ticket is unmet." }],
      recommendation: "Keep the legacy order.",
      affectedScope: ["modules/export"],
      independentWork: ["The reader tests continue."],
      escalationTriggers,
    }),
  );
  return runJson(
    workspace,
    ["question", "raise", "--request", request(), "--attempt", attempt.attemptId, "--input", path],
    attempt.worktreePath,
  );
}

async function answer(workspace: Workspace, ownerToken: string, question: Action) {
  const path = `${workspace.root}/answer-${crypto.randomUUID()}.json`;
  await Bun.write(
    path,
    JSON.stringify({
      authority: "operator-decision",
      interpretation: {
        summary: "Keep the legacy column order.",
        directives: ["Write the legacy order."],
        appliesTo: ["modules/export"],
      },
    }),
  );
  return runJson(workspace, [
    "question",
    "answer",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--question",
    String(question.questionId),
    "--revision",
    String(question.revision),
    "--input",
    path,
  ]);
}

describe("the next actions", () => {
  test("refuses a request that names no installation target", async () => {
    const workspace = await makeReviewWorkspace(fixtures);

    const reported = await runJson(workspace, ["crew", "next"]);

    expect(reported.exitCode).toBe(2);
    expect(reported.json.reason).toBe("missing_target");
  });

  test("answers a project with no crew state with the ownership it needs", async () => {
    const workspace = await makeReviewWorkspace(fixtures);

    const reported = await next(workspace);

    expect(reported.exitCode).toBe(0);
    expect(reported.json.reason).toBe("next_actions_reported");
    expect(reported.names).toEqual(["own_crew"]);
    expect(reported.of("own_crew").command).toBe("operator crew own");
  });

  test("puts readiness first and leaves that decision with the user", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await startProducer(workspace);

    const reported = await next(workspace);

    expect(reported.names[0]).toBe("prove_readiness");
    expect(reported.of("prove_readiness").needsUser).toBe(true);
    expect(reported.json.data.readiness.state).toBe("blocked");
    expect(
      reported.json.blockers.some((one: { reason: string }) => one.reason === "not_configured"),
    ).toBe(true);
  });

  test("offers the frontier order and withholds work its dependency gates", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const registered = await registerDependents(workspace, producer, [
      { key: "26.2", kind: "production", title: "Depends on the first item" },
    ]);

    const reported = await next(workspace);

    expect(reported.actions.some((one) => one.assignmentId === registered.get("26.2"))).toBe(false);
    const blocked = reported.json.data.frontier.blocked.find(
      (one: { assignmentId: string }) => one.assignmentId === registered.get("26.2"),
    );
    expect(blocked.blockers[0].reason).toBe("dependency_pending");
    expect(blocked.blockers[0].dependencies[0].assignmentId).toBe(producer.assignmentId);
  });

  test("reports the crew limit that decides what a one-agent crew may start", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 1 });
    const producer = await startProducer(workspace);
    const registered = await registerDependents(workspace, producer, [
      { key: "26.2", kind: "production", title: "Independent work", dependsOn: [] },
    ]);

    const reported = await next(workspace);

    expect(reported.json.data.capacity.limit).toBe(1);
    expect(reported.json.data.capacity.reviewReserve).toBe(0);
    expect(reported.names).not.toContain("claim_assignment");
    const blocked = reported.json.data.frontier.blocked.find(
      (one: { assignmentId: string }) => one.assignmentId === registered.get("26.2"),
    );
    expect(blocked.blockers[0].reason).toBe("crew_at_capacity");
  });

  test("waits for the acknowledgement instead of offering the attempt again", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const owned = await runJson(workspace, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "operator-session",
    ]);
    const ownerToken = owned.json.data.ownerToken;
    const path = `${workspace.root}/work.json`;
    await Bun.write(
      path,
      JSON.stringify({
        sourceKind: "specification",
        source: { id: "github:operator#26", revision: "rev-1", tracker: "github" },
        items: [
          {
            key: "26.1",
            title: "Coordinate the workflow",
            kind: "production",
            approvedScope: "Coordinate the workflow.",
            acceptanceRequirements: ["The quality gate passes."],
            permissions: {
              writePaths: ["modules/"],
              allowedCommands: ["bun test"],
              network: false,
            },
            fixedInputs: [],
            dependsOn: [],
          },
        ],
      }),
    );
    const registered = await runJson(workspace, [
      "work",
      "register",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--input",
      path,
    ]);
    const assignmentId = registered.json.data.registered[0].assignmentId;

    const offered = await next(workspace);
    expect(offered.of("claim_assignment").assignmentId).toBe(assignmentId);

    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--assignment",
      assignmentId,
      "--revision",
      "1",
    ]);
    const claimedNext = await next(workspace);
    expect(claimedNext.of("dispatch_attempt").attemptId).toBe(claimed.json.data.attemptId);

    await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--attempt",
      claimed.json.data.attemptId,
      "--commit",
      await headCommit(workspace),
      "--worktree",
      `${workspace.root}/operative`,
    ]);

    const waiting = await next(workspace);
    expect(waiting.exitCode).toBe(6);
    expect(waiting.json.reason).toBe("next_actions_waiting");
    expect(waiting.waits[0]?.wait).toBe("acknowledgement_pending");
    expect(waiting.waits[0]?.agentName).toBeTruthy();
    expect(waiting.names).not.toContain("dispatch_attempt");
  });

  test("asks for a reconciliation when an effect never answered", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await Bun.write(`${workspace.herdr}/agent-prompt.garbage`, "");
    await raise(workspace, producer);
    await runJson(workspace, [
      "question",
      "answer",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--question",
      (await next(workspace)).of("answer_question").questionId ?? "",
      "--revision",
      "1",
      "--input",
      await (async () => {
        const path = `${workspace.root}/answer.json`;
        await Bun.write(
          path,
          JSON.stringify({
            authority: "operator-decision",
            interpretation: { summary: "Keep it.", directives: ["Keep it."], appliesTo: ["x"] },
          }),
        );
        return path;
      })(),
    ]);
    const questionId = (await next(workspace)).of("deliver_answer").questionId;
    await runJson(workspace, [
      "question",
      "deliver",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--question",
      String(questionId),
    ]);

    const reported = await next(workspace);

    expect(reported.of("reconcile_attempt").attemptId).toBe(producer.attemptId);
    expect(reported.names).not.toContain("deliver_answer");
  });

  test("offers an open question, and names the user when it names an escalation trigger", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await raise(workspace, producer, ["scope"]);

    const reported = await next(workspace);

    const question = reported.of("answer_question");
    expect(question.attemptId).toBe(producer.attemptId);
    expect(question.needsUser).toBe(true);
    expect(
      reported.json.blockers.some(
        (one: { reason: string }) => one.reason === "escalation_required",
      ),
    ).toBe(true);
  });

  test("carries an answered question to delivery and then waits for the receipt", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await raise(workspace, producer);

    const asked = await next(workspace);
    expect(asked.of("answer_question").needsUser).toBe(false);
    await answer(workspace, producer.ownerToken, asked.of("answer_question"));

    const answered = await next(workspace);
    const questionId = answered.of("deliver_answer").questionId;
    await runJson(workspace, [
      "question",
      "deliver",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--question",
      String(questionId),
    ]);

    const delivered = await next(workspace);
    expect(delivered.names).not.toContain("deliver_answer");
    expect(delivered.waits.map((one) => one.wait)).toContain("answer_acknowledgement_pending");

    await runJson(
      workspace,
      ["question", "acknowledge", "--request", request(), "--question", String(questionId)],
      producer.worktreePath,
    );
    const resolved = await next(workspace);
    expect(resolved.waits.map((one) => one.wait)).not.toContain("answer_acknowledgement_pending");
  });

  test("offers the queued review before new production work", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const registered = await registerDependents(workspace, producer, [
      { key: "26.2", kind: "production", title: "Independent work", dependsOn: [] },
    ]);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "the result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    const reported = await next(workspace);

    const claims = reported.actions.filter((one) => one.action === "claim_assignment");
    expect(claims[0]?.assignmentId).toBe(submitted.json.data.reviewAssignmentId);
    expect(claims[1]?.assignmentId).toBe(registered.get("26.2"));
    expect(reported.of("close_process").attemptId).toBe(producer.attemptId);
  });

  test("asks for the dispositions, then the acceptance", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "the result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        standardsFindings: [
          {
            key: "naming",
            severity: "improvement",
            summary: "One helper reads badly.",
            evidence: "modules/x.ts",
          },
        ],
      }),
    );

    const undisposed = await next(workspace);
    expect(undisposed.of("dispose_findings").reviewId).toBe(submitted.json.data.reviewId);

    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      {
        findingId: (
          await runJson(workspace, ["review", "show", "--review", submitted.json.data.reviewId])
        ).json.data.findings[0].findingId,
        disposition: "rejected",
        reason: "The name matches the rest of the module.",
        evidence: "modules/x.ts",
      },
    ]);

    const disposed = await next(workspace);
    const accept = disposed.actions.filter((one) => one.action === "accept_assignment");
    expect(accept.map((one) => one.assignmentId)).toContain(producer.assignmentId);
  });
});

describe("adoption", () => {
  test("blocks every attempt a replaced Operator claimed until this session adopts it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const ownerToken = await own(workspace, "second-session", 1);

    const taken = await next(workspace);
    expect(taken.of("adopt_attempt").attemptId).toBe(producer.attemptId);
    expect(taken.json.data.ownership.ownerLabel).toBe("second-session");

    const adopted = await adopt(workspace, ownerToken, producer.attemptId);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.json.reason).toBe("attempt_adopted");
    expect(adopted.json.data.report.stage).toBe("acknowledged");

    const after = await next(workspace);
    expect(after.names).not.toContain("adopt_attempt");
    expect(after.waits.map((one) => one.wait)).toContain("operative_working");
  });

  test("answers a second adoption of the same attempt without acting again", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const ownerToken = await own(workspace, "second-session", 1);
    await adopt(workspace, ownerToken, producer.attemptId);

    const again = await adopt(workspace, ownerToken, producer.attemptId);

    expect(again.exitCode).toBe(0);
    expect(again.json.reason).toBe("attempt_already_adopted");
  });

  test("refuses to adopt an attempt whose writer is gone", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const ownerToken = await own(workspace, "second-session", 1);
    await stopFakeAgents(workspace);

    const refused = await adopt(workspace, ownerToken, producer.attemptId);

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("adoption_writer_stopped");
    expect(refused.stdout).toContain("adoption_writer_stopped");
  });

  test("refuses to adopt an attempt whose effects are not settled", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const owned = await runJson(workspace, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "operator-session",
    ]);
    const ownerToken = owned.json.data.ownerToken;
    const path = `${workspace.root}/work.json`;
    await Bun.write(
      path,
      JSON.stringify({
        sourceKind: "ticket",
        source: { id: "github:operator#26", revision: "rev-1", tracker: "github" },
        items: [
          {
            key: "26.1",
            title: "Coordinate the workflow",
            kind: "production",
            approvedScope: "Coordinate the workflow.",
            acceptanceRequirements: ["The quality gate passes."],
            permissions: {
              writePaths: ["modules/"],
              allowedCommands: ["bun test"],
              network: false,
            },
            fixedInputs: [],
            dependsOn: [],
          },
        ],
      }),
    );
    const registered = await runJson(workspace, [
      "work",
      "register",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--input",
      path,
    ]);
    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--assignment",
      registered.json.data.registered[0].assignmentId,
      "--revision",
      "1",
    ]);
    await Bun.write(`${workspace.herdr}/agent-start.garbage`, "");
    const uncertain = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--attempt",
      claimed.json.data.attemptId,
      "--commit",
      await headCommit(workspace),
      "--worktree",
      `${workspace.root}/operative`,
    ]);
    expect(uncertain.exitCode).toBe(5);
    await markFakeAgent(workspace, uncertain.json.data.agentName);
    const second = await own(workspace, "second-session", 1);

    const refused = await adopt(workspace, second, claimed.json.data.attemptId);

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("reconciliation_required");
    const reported = await next(workspace);
    expect(reported.of("reconcile_attempt").attemptId).toBe(claimed.json.data.attemptId);
  });
});
