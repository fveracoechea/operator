import { afterEach, describe, expect, test } from "bun:test";
import {
  commitArtifact,
  delegateRework,
  disposeFindings,
  makeReviewWorkspace,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
  nextActions,
  ownCrew,
  requestId as request,
  runJson,
  stopFakeAgents,
  workspaces,
} from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

type ItemOverrides = {
  key: string;
  title?: string;
  kind?: "production" | "planning";
  wayfinderType?: "research" | "task";
  trackerIssue?: number;
  dependsOn?: string[];
};

function item(overrides: ItemOverrides) {
  const { key, kind, wayfinderType, dependsOn, trackerIssue } = overrides;
  return {
    key,
    title: overrides.title ?? `Item ${key}`,
    ...(wayfinderType === undefined ? { kind: kind ?? "production" } : { wayfinderType }),
    ...(trackerIssue === undefined ? {} : { trackerIssue }),
    approvedScope: `The approved scope of item ${key}.`,
    acceptanceRequirements: ["The quality gate passes."],
    permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
    fixedInputs: [],
    dependsOn: (dependsOn ?? []).map((one) => ({ key: one })),
  };
}

async function register(
  workspace: Workspace,
  ownerToken: string,
  source: {
    sourceKind: "specification" | "ticket" | "wayfinder";
    id: string;
    location?: { repository: string; mapIssue: number | null };
    items: ReturnType<typeof item>[];
  },
) {
  const registered = await runJson(workspace, [
    "work",
    "register",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--input",
    await writeInput(workspace, {
      sourceKind: source.sourceKind,
      source: {
        id: source.id,
        revision: "rev-1",
        tracker: "github",
        ...(source.location === undefined ? {} : { location: source.location }),
      },
      items: source.items,
    }),
  ]);
  return new Map<string, string>(
    registered.json.data.registered.map((one: { sourceKey: string; assignmentId: string }) => [
      one.sourceKey,
      one.assignmentId,
    ]),
  );
}

async function claim(workspace: Workspace, ownerToken: string, assignmentId: string) {
  return runJson(workspace, [
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
}

async function dispatch(
  workspace: Workspace,
  ownerToken: string,
  options: { attemptId: string; worktreePath: string; extra?: string[] },
) {
  return runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--attempt",
    options.attemptId,
    "--commit",
    await headCommit(workspace),
    "--worktree",
    options.worktreePath,
    ...(options.extra ?? []),
  ]);
}

async function acknowledge(workspace: Workspace, attemptId: string, worktreePath: string) {
  return runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    worktreePath,
  );
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

describe("the three entry points", () => {
  test("offers the items of an approved specification in the order they were registered", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" }), item({ key: "15.2", dependsOn: ["15.1"] })],
    });

    const reported = await nextActions(workspace);

    expect(reported.forAction("claim_assignment").map((one) => one.assignmentId)).toEqual([
      registered.get("15.1") ?? null,
    ]);
    expect(reported.json.data.frontier.dispatchable[0].sourceKind).toBe("specification");
  });

  test("offers the items of a ready ticket", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "ticket",
      id: "github:operator#26",
      items: [item({ key: "26.1" })],
    });

    const reported = await nextActions(workspace);

    expect(reported.forAction("claim_assignment")[0]?.assignmentId).toBe(registered.get("26.1"));
    expect(reported.json.data.frontier.dispatchable[0].sourceKind).toBe("ticket");
  });

  test("resolves the planning work of a wayfinder map before the task that depends on it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [
        item({ key: "1.1", wayfinderType: "research" }),
        item({ key: "1.2", wayfinderType: "task", dependsOn: ["1.1"] }),
      ],
    });

    const offered = await nextActions(workspace);
    expect(offered.forAction("resolve_planning")[0]?.assignmentId).toBe(registered.get("1.1"));
    expect(offered.names).not.toContain("claim_assignment");

    await runJson(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--assignment",
      String(registered.get("1.1")),
      "--revision",
      "1",
    ]);

    const resolved = await nextActions(workspace);
    expect(resolved.names).not.toContain("resolve_planning");
    expect(resolved.forAction("claim_assignment")[0]?.assignmentId).toBe(registered.get("1.2"));
  });

  test("reports the tracker steps a wayfinder assignment still owes after acceptance", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      id: "github:fveracoechea/operator#1",
      location: { repository: "fveracoechea/operator", mapIssue: 1 },
      items: [item({ key: "24", wayfinderType: "research", trackerIssue: 24 })],
    });
    const assignmentId = String(registered.get("24"));

    const accepted = await runJson(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--assignment",
      assignmentId,
      "--revision",
      "1",
    ]);
    expect(accepted.exitCode).toBe(0);

    const reported = await nextActions(workspace);

    const steps = reported.forAction("record_tracker");
    expect(steps).toHaveLength(3);
    expect(steps.every((one) => one.assignmentId === assignmentId)).toBe(true);
    const shown = await runJson(workspace, ["tracker", "show", "--assignment", assignmentId]);
    expect(shown.json.data.issue).toBe(24);
    expect(shown.json.data.mapIssue).toBe(1);
  });
});

describe("a fresh Operator after session loss", () => {
  test("adopts an assignment that was claimed and never launched", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" })],
    });
    const claimed = await claim(workspace, ownerToken, String(registered.get("15.1")));
    const second = await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });

    const blocked = await nextActions(workspace);
    expect(blocked.forAction("adopt_attempt")[0]?.attemptId).toBe(claimed.json.data.attemptId);

    const adopted = await adopt(workspace, second, claimed.json.data.attemptId);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.json.data.report).toBeNull();

    const resumed = await nextActions(workspace);
    expect(resumed.forAction("dispatch_attempt")[0]?.attemptId).toBe(claimed.json.data.attemptId);

    const launched = await dispatch(workspace, second, {
      attemptId: claimed.json.data.attemptId,
      worktreePath: `${workspace.root}/operative`,
    });
    expect(launched.exitCode).toBe(6);
  });

  test("adopts an Operative that has not acknowledged its brief yet", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" })],
    });
    const claimed = await claim(workspace, ownerToken, String(registered.get("15.1")));
    const worktreePath = `${workspace.root}/operative`;
    await dispatch(workspace, ownerToken, { attemptId: claimed.json.data.attemptId, worktreePath });
    const second = await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });

    await adopt(workspace, second, claimed.json.data.attemptId);

    const waiting = await nextActions(workspace);
    expect(waiting.exitCode).toBe(6);
    expect(waiting.waits[0]?.wait).toBe("acknowledgement_pending");

    const acknowledged = await acknowledge(workspace, claimed.json.data.attemptId, worktreePath);
    expect(acknowledged.exitCode).toBe(0);
  });

  test("keeps an open question open across the session that recorded it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    await runJson(
      workspace,
      [
        "question",
        "raise",
        "--request",
        request(),
        "--attempt",
        producer.attemptId,
        "--input",
        await writeInput(workspace, {
          question: "Does this change what the user sees?",
          evidence: [{ label: "spec", detail: "The spec does not say." }],
          options: [{ name: "keep", detail: "Keep the current view.", risk: "The spec is unmet." }],
          recommendation: "Ask the user.",
          affectedScope: ["modules/view"],
          independentWork: ["The reader tests continue."],
          escalationTriggers: ["visible-behavior"],
        }),
      ],
      producer.worktreePath,
    );
    const second = await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });
    await adopt(workspace, second, producer.attemptId);

    const reported = await nextActions(workspace);

    const question = reported.forAction("answer_question")[0];
    expect(question?.attemptId).toBe(producer.attemptId);
    expect(question?.blocker).toBe("escalation_required");
    const shown = await runJson(workspace, [
      "question",
      "show",
      "--question",
      String(question?.questionId),
    ]);
    expect(shown.json.data.escalationTriggers).toEqual(["visible-behavior"]);
  });

  test("resumes a submitted result without adopting an attempt that already ended", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "the result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    expect(submitted.exitCode).toBe(6);
    await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });

    const reported = await nextActions(workspace);

    expect(reported.names).not.toContain("adopt_attempt");
    expect(reported.forAction("claim_assignment")[0]?.assignmentId).toBe(
      submitted.json.data.reviewAssignmentId,
    );
    expect(reported.forAction("close_process")[0]?.attemptId).toBe(producer.attemptId);
  });

  test("resumes a review that already reported", async () => {
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
    const second = await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });

    const inherited = await nextActions(workspace);
    expect(inherited.forAction("adopt_attempt")[0]?.attemptId).toBe(reviewer.attemptId);
    expect(inherited.forAction("dispose_findings")[0]?.assignmentId).toBe(producer.assignmentId);

    await adopt(workspace, second, reviewer.attemptId);
    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    await disposeFindings(
      workspace,
      { ...producer, ownerToken: second },
      submitted.json.data.reviewId,
      [
        {
          findingId: shown.json.data.findings[0].findingId,
          disposition: "rejected",
          reason: "The name matches the rest of the module.",
          evidence: "modules/x.ts",
        },
      ],
    );

    const disposed = await nextActions(workspace);
    expect(disposed.forAction("accept_assignment").map((one) => one.assignmentId)).toContain(
      producer.assignmentId,
    );
  });

  test("resumes an assignment whose rework cycle is still open", async () => {
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
            key: "coverage",
            severity: "blocker",
            summary: "The reader path has no test.",
            evidence: "modules/x.ts",
          },
        ],
      }),
    );
    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      submitted.json.data.reviewId,
    ]);
    const findingId = shown.json.data.findings[0].findingId;
    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      { findingId, disposition: "corrected", reason: "The reader path needs its test." },
    ]);
    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "findings",
        reviewId: submitted.json.data.reviewId,
        instruction: "Add the reader test the review asked for.",
        conflicts: [],
      },
    });
    expect(delegated.json.reason).toBe("rework_delegated");
    await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });

    const inherited = await nextActions(workspace);

    // The cycle is delegated, so the fresh session takes the work again and never re-delegates.
    expect(inherited.names).not.toContain("delegate_rework");
    expect(inherited.forAction("claim_assignment").map((one) => one.assignmentId)).toContain(
      producer.assignmentId,
    );
    expect(inherited.forAction("adopt_attempt")[0]?.attemptId).toBe(reviewer.attemptId);
  });

  test("resumes the tracker steps of work another session accepted", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      id: "github:fveracoechea/operator#1",
      location: { repository: "fveracoechea/operator", mapIssue: 1 },
      items: [item({ key: "24", wayfinderType: "research", trackerIssue: 24 })],
    });
    const assignmentId = String(registered.get("24"));
    await runJson(workspace, [
      "work",
      "accept",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--assignment",
      assignmentId,
      "--revision",
      "1",
    ]);
    await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });

    const inherited = await nextActions(workspace);

    expect(inherited.forAction("record_tracker")).toHaveLength(3);
    expect(
      inherited.forAction("record_tracker").every((one) => one.assignmentId === assignmentId),
    ).toBe(true);
  });

  test("keeps a retention hold visible to the session that inherits it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "the result\n");
    await submit(workspace, producer, submissionBody(producer, artifact, base));
    const held = await runJson(workspace, [
      "cleanup",
      "hold",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      producer.attemptId,
      "--input",
      await writeInput(workspace, {
        reason: "open-investigation",
        detail: "The flaky test is still being diagnosed in this checkout.",
      }),
    ]);
    expect(held.json.reason).toBe("resources_held");
    await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });

    const inherited = await nextActions(workspace);

    const wait = inherited.waits.find((one) => one.attemptId === producer.attemptId);
    expect(wait?.wait).toBe("cleanup_held");
    expect(wait?.detail).toContain("open-investigation");
    expect(inherited.names).not.toContain("close_process");
  });

  test("sends a stopped Operative to replacement instead of adoption", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const second = await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });
    await stopFakeAgents(workspace);

    const refused = await adopt(workspace, second, producer.attemptId);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("adoption_writer_stopped");

    const inspected = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      second,
      "--attempt",
      producer.attemptId,
    ]);
    expect(inspected.json.reason).toBe("inspection_required");

    const replaced = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      second,
      "--attempt",
      producer.attemptId,
      "--inspection",
      inspected.json.data.identity,
    ]);
    expect(replaced.exitCode).toBe(0);

    const resumed = await nextActions(workspace);
    expect(resumed.names).not.toContain("adopt_attempt");
    expect(resumed.forAction("dispatch_attempt")[0]?.attemptId).toBe(replaced.json.data.attemptId);
  });
});

describe("crew capacity", () => {
  test("offers three assignments to a crew of three and holds one slot for review", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" }), item({ key: "15.2" }), item({ key: "15.3" })],
    });

    const reported = await nextActions(workspace);

    expect(reported.json.data.capacity.limit).toBe(3);
    expect(reported.json.data.capacity.reviewReserve).toBe(1);
    expect(reported.forAction("claim_assignment").map((one) => one.assignmentId)).toEqual([
      registered.get("15.1") ?? null,
      registered.get("15.2") ?? null,
    ]);
    const held = reported.json.data.frontier.blocked.find(
      (one: { assignmentId: string }) => one.assignmentId === registered.get("15.3"),
    );
    expect(held.blockers[0].reason).toBe("review_capacity_reserved");
  });

  test("runs one assignment at a time in a crew of one", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { maxActiveAgents: 1 });
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" }), item({ key: "15.2" })],
    });

    const offered = await nextActions(workspace);
    expect(offered.json.data.capacity.reviewReserve).toBe(0);
    expect(offered.forAction("claim_assignment").map((one) => one.assignmentId)).toEqual([
      registered.get("15.1") ?? null,
    ]);

    await claim(workspace, ownerToken, String(registered.get("15.1")));

    const full = await nextActions(workspace);
    expect(full.names).not.toContain("claim_assignment");
    const held = full.json.data.frontier.blocked.find(
      (one: { assignmentId: string }) => one.assignmentId === registered.get("15.2"),
    );
    expect(held.blockers[0].reason).toBe("crew_at_capacity");
  });
});

describe("either supported host as Operator", () => {
  test("runs the same loop against an OpenCode installation target", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { host: "opencode" });
    const targets = ["--opencode", "--operator-host", "opencode"];

    const empty = await nextActions(workspace, targets);
    expect(empty.json.data.readiness.targets).toEqual(["opencode"]);
    expect(empty.json.data.readiness.selection.operator.host).toBe("opencode");
    expect(empty.names).toEqual(["prove_readiness", "own_crew"]);

    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" })],
    });
    const assignmentId = String(registered.get("15.1"));

    const offered = await nextActions(workspace, targets);
    expect(offered.forAction("claim_assignment")[0]?.assignmentId).toBe(assignmentId);

    const claimed = await claim(workspace, ownerToken, assignmentId);
    const worktreePath = `${workspace.root}/operative`;
    expect(offered.exitCode).toBe(0);

    const launch = await nextActions(workspace, targets);
    expect(launch.forAction("dispatch_attempt")[0]?.attemptId).toBe(claimed.json.data.attemptId);

    const dispatched = await dispatch(workspace, ownerToken, {
      attemptId: claimed.json.data.attemptId,
      worktreePath,
    });
    expect(dispatched.json.data.agentHost).toBe("opencode");
    await acknowledge(workspace, claimed.json.data.attemptId, worktreePath);

    const working = await nextActions(workspace, targets);
    expect(working.exitCode).toBe(6);
    expect(working.waiting).toEqual(["operative_working"]);
  });
});

describe("a mixed-host crew", () => {
  test("launches each Operative on the host its own dispatch fixed", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await ownCrew(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" }), item({ key: "15.2" })],
    });

    const first = await claim(workspace, ownerToken, String(registered.get("15.1")));
    const second = await claim(workspace, ownerToken, String(registered.get("15.2")));

    const onProject = await dispatch(workspace, ownerToken, {
      attemptId: first.json.data.attemptId,
      worktreePath: `${workspace.root}/operative-one`,
    });
    const onOverride = await dispatch(workspace, ownerToken, {
      attemptId: second.json.data.attemptId,
      worktreePath: `${workspace.root}/operative-two`,
      extra: ["--crew-host", "opencode"],
    });

    expect(onProject.json.data.agentHost).toBe("claude-code");
    expect(onOverride.json.data.agentHost).toBe("opencode");

    // The recorded launch is what a recovery restores, so the two hosts stay apart afterwards.
    const shownFirst = await runJson(workspace, [
      "attempt",
      "show",
      "--attempt",
      first.json.data.attemptId,
    ]);
    const shownSecond = await runJson(workspace, [
      "attempt",
      "show",
      "--attempt",
      second.json.data.attemptId,
    ]);
    expect(shownFirst.json.data.agentHost).toBe("claude-code");
    expect(shownSecond.json.data.agentHost).toBe("opencode");
  });
});

describe("a direct instruction from a person to an Operative", () => {
  test("reaches the crew state as a human answer with the exact words preserved", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const exactText = "drop the second column, I only ever read the first one";

    // The Operative never acts on a message it receives directly. It reports what it was told.
    const raised = await runJson(
      workspace,
      [
        "question",
        "raise",
        "--request",
        request(),
        "--attempt",
        producer.attemptId,
        "--input",
        await writeInput(workspace, {
          question: `Someone asked me directly: "${exactText}". Does that instruction stand?`,
          evidence: [
            { label: "direct message", detail: `The exact words were: ${exactText}` },
            { label: "spec", detail: "The approved scope names both columns." },
          ],
          options: [
            { name: "follow", detail: "Drop the column.", risk: "The approved scope changes." },
            { name: "keep", detail: "Keep both columns.", risk: "The person is not served." },
          ],
          recommendation: "The Operator confirms this with the user before I act on it.",
          affectedScope: ["modules/export"],
          independentWork: ["The reader tests continue."],
          escalationTriggers: ["scope"],
        }),
      ],
      producer.worktreePath,
    );
    expect(raised.exitCode).toBe(6);
    expect(raised.json.reason).toBe("question_raised");

    const asked = await nextActions(workspace);
    const question = asked.forAction("answer_question")[0];
    expect(question?.blocker).toBe("escalation_required");

    // An Operator decision is refused, because the question names a subject only a person settles.
    const decided = await runJson(workspace, [
      "question",
      "answer",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--question",
      String(question?.questionId),
      "--revision",
      String(question?.revision),
      "--input",
      await writeInput(workspace, {
        authority: "operator-decision",
        interpretation: {
          summary: "Drop the column.",
          directives: ["Drop the second column."],
          appliesTo: ["modules/export"],
        },
      }),
    ]);
    expect(decided.exitCode).toBe(3);
    expect(decided.json.reason).toBe("escalation_required");

    const answered = await runJson(workspace, [
      "question",
      "answer",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--question",
      String(question?.questionId),
      "--revision",
      String(question?.revision),
      "--input",
      await writeInput(workspace, {
        authority: "human-answer",
        exactText,
        interpretation: {
          summary: "The user confirmed the instruction.",
          directives: ["Drop the second column."],
          appliesTo: ["modules/export"],
        },
      }),
    ]);
    expect(answered.exitCode).toBe(0);

    const delivered = await runJson(workspace, [
      "question",
      "deliver",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--question",
      String(question?.questionId),
    ]);
    expect(delivered.exitCode).toBe(6);
    expect((await nextActions(workspace)).waits.map((one) => one.wait)).toContain(
      "answer_acknowledgement_pending",
    );

    await runJson(
      workspace,
      [
        "question",
        "acknowledge",
        "--request",
        request(),
        "--question",
        String(question?.questionId),
      ],
      producer.worktreePath,
    );

    const shown = await runJson(workspace, [
      "question",
      "show",
      "--question",
      String(question?.questionId),
    ]);
    expect(shown.json.data.answer.authority).toBe("human-answer");
    expect(shown.json.data.answer.exactText).toBe(exactText);
    expect(shown.json.data.answer.interpretation.summary).toBe(
      "The user confirmed the instruction.",
    );
    expect(shown.json.data.state).toBe("resolved");
  });
});
