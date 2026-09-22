import { afterEach, describe, expect, test } from "bun:test";
import {
  commitArtifact,
  makeReviewWorkspace,
  startProducer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
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
  assignmentId: string | null;
  attemptId: string | null;
  questionId: string | null;
  revision: number | null;
  needsUser: boolean;
};

type Wait = { wait: string; assignmentId: string; attemptId: string };

async function next(workspace: Workspace) {
  const result = await runJson(workspace, ["crew", "next", "--claude"]);
  const actions: Action[] = result.json.data.actions ?? [];
  const waits: Wait[] = result.json.data.waits ?? [];
  return {
    ...result,
    actions,
    waits,
    names: actions.map((one) => one.action),
    forAction(name: string): Action[] {
      return actions.filter((one) => one.action === name);
    },
  };
}

async function writeInput(workspace: Workspace, value: unknown): Promise<string> {
  const path = `${workspace.root}/input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

async function own(workspace: Workspace, label = "operator-session"): Promise<string> {
  const owned = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    label,
  ]);
  return owned.json.data.ownerToken;
}

/** Takes the crew from a session that is gone, which is what a fresh Operator does first. */
async function takeOver(workspace: Workspace, revision: number, label = "second-session") {
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
  return taken.json.data.ownerToken as string;
}

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
    const ownerToken = await own(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" }), item({ key: "15.2", dependsOn: ["15.1"] })],
    });

    const reported = await next(workspace);

    expect(reported.forAction("claim_assignment").map((one) => one.assignmentId)).toEqual([
      registered.get("15.1") ?? null,
    ]);
    expect(reported.json.data.frontier.dispatchable[0].sourceKind).toBe("specification");
  });

  test("offers the items of a ready ticket", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await own(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "ticket",
      id: "github:operator#26",
      items: [item({ key: "26.1" })],
    });

    const reported = await next(workspace);

    expect(reported.forAction("claim_assignment")[0]?.assignmentId).toBe(registered.get("26.1"));
    expect(reported.json.data.frontier.dispatchable[0].sourceKind).toBe("ticket");
  });

  test("resolves the planning work of a wayfinder map before the task that depends on it", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await own(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      id: "github:operator#1",
      items: [
        item({ key: "1.1", wayfinderType: "research" }),
        item({ key: "1.2", wayfinderType: "task", dependsOn: ["1.1"] }),
      ],
    });

    const offered = await next(workspace);
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

    const resolved = await next(workspace);
    expect(resolved.names).not.toContain("resolve_planning");
    expect(resolved.forAction("claim_assignment")[0]?.assignmentId).toBe(registered.get("1.2"));
  });

  test("reports the tracker steps a wayfinder assignment still owes after acceptance", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await own(workspace);
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

    const reported = await next(workspace);

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
    const ownerToken = await own(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" })],
    });
    const claimed = await claim(workspace, ownerToken, String(registered.get("15.1")));
    const second = await takeOver(workspace, 1);

    const blocked = await next(workspace);
    expect(blocked.forAction("adopt_attempt")[0]?.attemptId).toBe(claimed.json.data.attemptId);

    const adopted = await adopt(workspace, second, claimed.json.data.attemptId);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.json.data.report).toBeNull();

    const resumed = await next(workspace);
    expect(resumed.forAction("dispatch_attempt")[0]?.attemptId).toBe(claimed.json.data.attemptId);

    const launched = await dispatch(workspace, second, {
      attemptId: claimed.json.data.attemptId,
      worktreePath: `${workspace.root}/operative`,
    });
    expect(launched.exitCode).toBe(6);
  });

  test("adopts an Operative that has not acknowledged its brief yet", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await own(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" })],
    });
    const claimed = await claim(workspace, ownerToken, String(registered.get("15.1")));
    const worktreePath = `${workspace.root}/operative`;
    await dispatch(workspace, ownerToken, { attemptId: claimed.json.data.attemptId, worktreePath });
    const second = await takeOver(workspace, 1);

    await adopt(workspace, second, claimed.json.data.attemptId);

    const waiting = await next(workspace);
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
    const second = await takeOver(workspace, 1);
    await adopt(workspace, second, producer.attemptId);

    const reported = await next(workspace);

    const question = reported.forAction("answer_question")[0];
    expect(question?.attemptId).toBe(producer.attemptId);
    expect(question?.needsUser).toBe(true);
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
    await takeOver(workspace, 1);

    const reported = await next(workspace);

    expect(reported.names).not.toContain("adopt_attempt");
    expect(reported.forAction("claim_assignment")[0]?.assignmentId).toBe(
      submitted.json.data.reviewAssignmentId,
    );
    expect(reported.forAction("close_process")[0]?.attemptId).toBe(producer.attemptId);
  });

  test("sends a stopped Operative to replacement instead of adoption", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const second = await takeOver(workspace, 1);
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

    const resumed = await next(workspace);
    expect(resumed.names).not.toContain("adopt_attempt");
    expect(resumed.forAction("dispatch_attempt")[0]?.attemptId).toBe(replaced.json.data.attemptId);
  });
});

describe("crew capacity", () => {
  test("offers three assignments to a crew of three and holds one slot for review", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await own(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" }), item({ key: "15.2" }), item({ key: "15.3" })],
    });

    const reported = await next(workspace);

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
    const ownerToken = await own(workspace);
    const registered = await register(workspace, ownerToken, {
      sourceKind: "specification",
      id: "github:operator#15",
      items: [item({ key: "15.1" }), item({ key: "15.2" })],
    });

    const offered = await next(workspace);
    expect(offered.json.data.capacity.reviewReserve).toBe(0);
    expect(offered.forAction("claim_assignment").map((one) => one.assignmentId)).toEqual([
      registered.get("15.1") ?? null,
    ]);

    await claim(workspace, ownerToken, String(registered.get("15.1")));

    const full = await next(workspace);
    expect(full.names).not.toContain("claim_assignment");
    const held = full.json.data.frontier.blocked.find(
      (one: { assignmentId: string }) => one.assignmentId === registered.get("15.2"),
    );
    expect(held.blockers[0].reason).toBe("crew_at_capacity");
  });
});

describe("a mixed-host crew", () => {
  test("launches each Operative on the host its own dispatch fixed", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const ownerToken = await own(workspace);
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

    const asked = await next(workspace);
    const question = asked.forAction("answer_question")[0];
    expect(question?.needsUser).toBe(true);

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
    expect((await next(workspace)).waits.map((one) => one.wait)).toContain(
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
