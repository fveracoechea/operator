import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal or real-path API.
import { realpath, rm } from "node:fs/promises";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const fakeHerdr = new URL("./fixtures/fake-herdr.sh", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

type Workspace = { root: string; repo: string; herdr: string; bin: string };

async function makeWorkspace(): Promise<Workspace> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-question-${crypto.randomUUID()}`;
  temporaryRoots.push(root);

  const workspace: Workspace = {
    root,
    repo: `${root}/repo`,
    herdr: `${root}/herdr`,
    bin: `${root}/bin`,
  };
  await Bun.$`mkdir -p ${workspace.repo} ${workspace.herdr} ${workspace.bin}`.quiet();
  await Bun.$`cp ${fakeHerdr} ${workspace.bin}/herdr`.quiet();
  await Bun.$`chmod +x ${workspace.bin}/herdr`.quiet();

  await Bun.write(
    `${workspace.repo}/.operator/config.json`,
    `${JSON.stringify({ crew: { host: "claude-code" } })}\n`,
  );
  await Bun.write(`${workspace.repo}/README.md`, "# Fixture\n");
  await Bun.$`git init -b main ${workspace.repo}`.quiet();
  await Bun.$`git -C ${workspace.repo} add -A`.quiet();
  await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit -m first`.quiet();

  workspace.repo = await realpath(workspace.repo);
  return workspace;
}

async function runOperator(workspace: Workspace, args: string[], cwd = workspace.repo) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      PATH: `${workspace.bin}:${process.env.PATH ?? ""}`,
      HERDR_FAKE_DIR: workspace.herdr,
    },
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function runJson(workspace: Workspace, args: string[], cwd = workspace.repo) {
  const result = await runOperator(workspace, [...args, "--json"], cwd);
  return { ...result, json: JSON.parse(result.stdout) };
}

function request(): string {
  return crypto.randomUUID();
}

async function writeInput(workspace: Workspace, body: unknown): Promise<string> {
  const path = `${workspace.root}/input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(body));
  return path;
}

type ItemOverrides = { key: string; title?: string };

function item(overrides: ItemOverrides) {
  return {
    key: overrides.key,
    title: overrides.title ?? `Item ${overrides.key}`,
    kind: "production",
    approvedScope: `The approved scope of item ${overrides.key}.`,
    acceptanceRequirements: ["The quality gate passes."],
    permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
    fixedInputs: [
      { name: "brief", kind: "value", value: `brief ${overrides.key}`, contentIdentity: null },
    ],
    dependsOn: [],
  };
}

/** A crew with one dispatched and acknowledged Operative, which is what a question needs. */
async function dispatchedCrew(workspace: Workspace, keys: string[] = ["21.1"]) {
  const owned = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    "operator-session",
  ]);
  const ownerToken = owned.json.data.ownerToken;

  const inputPath = await writeInput(workspace, {
    sourceKind: "specification",
    source: { id: "github:operator#21", revision: "rev-1", tracker: "github" },
    items: keys.map((key) => item({ key })),
  });
  const registered = await runJson(workspace, [
    "work",
    "register",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--input",
    inputPath,
  ]);

  const first = registered.json.data.registered[0];
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    first.assignmentId,
    "--revision",
    "1",
  ]);

  const head = (await Bun.$`git -C ${workspace.repo} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();
  const worktree = `${workspace.root}/operative`;
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
    head,
    "--worktree",
    worktree,
  ]);
  await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", claimed.json.data.attemptId],
    worktree,
  );

  return {
    ownerToken,
    worktree,
    assignmentId: first.assignmentId,
    assignmentRevision: claimed.json.data.revision as number,
    attemptId: claimed.json.data.attemptId,
    registered: registered.json.data.registered as Array<{
      sourceKey: string;
      assignmentId: string;
    }>,
  };
}

type QuestionOverrides = {
  question?: string;
  affectedScope?: string[];
  independentWork?: string[];
  escalationTriggers?: string[];
  recommendation?: string;
};

function questionBody(overrides: QuestionOverrides = {}) {
  return {
    question: overrides.question ?? "Does the export keep the legacy column order?",
    evidence: [
      { label: "ticket", detail: "The ticket states a new order." },
      { label: "code", detail: "The reader assumes the old order." },
    ],
    options: [
      { name: "keep", detail: "Keep the legacy order.", risk: "The ticket is not satisfied." },
      { name: "change", detail: "Use the new order.", risk: "Existing readers break." },
    ],
    recommendation: overrides.recommendation ?? "Keep the legacy order behind a flag.",
    affectedScope: overrides.affectedScope ?? ["modules/export"],
    independentWork: overrides.independentWork ?? ["The reader tests continue."],
    escalationTriggers: overrides.escalationTriggers ?? [],
  };
}

async function raise(
  workspace: Workspace,
  crew: { attemptId: string; worktree: string },
  overrides: QuestionOverrides = {},
) {
  const inputPath = await writeInput(workspace, questionBody(overrides));
  return runJson(
    workspace,
    [
      "question",
      "raise",
      "--request",
      request(),
      "--attempt",
      crew.attemptId,
      "--input",
      inputPath,
    ],
    crew.worktree,
  );
}

async function revise(
  workspace: Workspace,
  crew: { attemptId: string; worktree: string },
  questionId: string,
  revision: number,
  overrides: QuestionOverrides = {},
) {
  const inputPath = await writeInput(workspace, questionBody(overrides));
  return runJson(
    workspace,
    [
      "question",
      "revise",
      "--request",
      request(),
      "--attempt",
      crew.attemptId,
      "--question",
      questionId,
      "--revision",
      String(revision),
      "--input",
      inputPath,
    ],
    crew.worktree,
  );
}

type AnswerOverrides = {
  authority?: "requirement" | "human-answer" | "operator-decision";
  exactText?: string;
  source?: { id: string; revision: string };
};

function answerBody(overrides: AnswerOverrides = {}) {
  const authority = overrides.authority ?? "operator-decision";
  const interpretation = {
    summary: "Keep the legacy column order.",
    directives: ["Write the legacy order.", "Add a flag for the new order."],
    appliesTo: ["modules/export"],
  };

  if (authority === "operator-decision") {
    return { authority, interpretation };
  }
  if (authority === "human-answer") {
    return {
      authority,
      exactText: overrides.exactText ?? "keep the old order, we have readers in the field",
      interpretation,
    };
  }

  return {
    authority,
    exactText: overrides.exactText ?? "The export preserves the legacy column order.",
    source: overrides.source ?? { id: "github:operator#21", revision: "rev-1" },
    interpretation,
  };
}

async function answer(
  workspace: Workspace,
  crew: { ownerToken: string },
  question: { questionId: string; revision: number },
  overrides: AnswerOverrides = {},
) {
  const inputPath = await writeInput(workspace, answerBody(overrides));
  return runJson(workspace, [
    "question",
    "answer",
    "--request",
    request(),
    "--owner-token",
    crew.ownerToken,
    "--question",
    question.questionId,
    "--revision",
    String(question.revision),
    "--input",
    inputPath,
  ]);
}

async function deliver(workspace: Workspace, crew: { ownerToken: string }, questionId: string) {
  return runJson(workspace, [
    "question",
    "deliver",
    "--request",
    request(),
    "--owner-token",
    crew.ownerToken,
    "--question",
    questionId,
  ]);
}

async function escalate(
  workspace: Workspace,
  crew: { ownerToken: string },
  questionId: string,
  revision: number,
  escalation: { escalationTriggers: string[]; reason: string },
) {
  const inputPath = await writeInput(workspace, escalation);
  return runJson(workspace, [
    "question",
    "escalate",
    "--request",
    request(),
    "--owner-token",
    crew.ownerToken,
    "--question",
    questionId,
    "--revision",
    String(revision),
    "--input",
    inputPath,
  ]);
}

async function reapply(
  workspace: Workspace,
  crew: { ownerToken: string },
  request_: { questionId: string; revision: number; answerId: string; approvalId: string },
) {
  return runJson(workspace, [
    "question",
    "reapply",
    "--request",
    request(),
    "--owner-token",
    crew.ownerToken,
    "--question",
    request_.questionId,
    "--revision",
    String(request_.revision),
    "--answer",
    request_.answerId,
    "--approval",
    request_.approvalId,
  ]);
}

type ApprovalOverrides = {
  action?: string;
  targets?: string[];
  scope?: string;
  requestRevision?: string;
  exactText?: string;
};

async function grant(
  workspace: Workspace,
  crew: { ownerToken: string },
  overrides: ApprovalOverrides = {},
) {
  const inputPath = await writeInput(workspace, {
    action: overrides.action ?? "host-permission-dialog",
    targets: overrides.targets ?? ["bun test"],
    scope: overrides.scope ?? "attempt",
    requestRevision: overrides.requestRevision ?? "1",
    exactText: overrides.exactText ?? "yes, it may run the test command",
    grantedBy: "human",
  });
  return runJson(workspace, [
    "approval",
    "grant",
    "--request",
    request(),
    "--owner-token",
    crew.ownerToken,
    "--input",
    inputPath,
  ]);
}

async function check(workspace: Workspace, overrides: ApprovalOverrides = {}) {
  const inputPath = await writeInput(workspace, {
    action: overrides.action ?? "host-permission-dialog",
    targets: overrides.targets ?? ["bun test"],
    scope: overrides.scope ?? "attempt",
    requestRevision: overrides.requestRevision ?? "1",
  });
  return runJson(workspace, ["approval", "check", "--input", inputPath]);
}

describe("operator question raise", () => {
  test("records the question, its evidence, options, scope, and independent work", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);

    const raised = await raise(workspace, crew);

    expect(raised.exitCode).toBe(6);
    expect(raised.json.reason).toBe("question_raised");
    expect(raised.json.data.assignmentId).toBe(crew.assignmentId);
    expect(raised.json.data.revision).toBe(1);
    expect(raised.json.data.independentWork).toEqual(["The reader tests continue."]);

    const shown = await runJson(workspace, [
      "question",
      "show",
      "--question",
      raised.json.data.questionId,
    ]);
    expect(shown.exitCode).toBe(0);
    expect(shown.json.data.report.evidence).toHaveLength(2);
    expect(shown.json.data.report.options).toHaveLength(2);
    expect(shown.json.data.report.recommendation).toBe("Keep the legacy order behind a flag.");
    expect(shown.json.data.report.affectedScope).toEqual(["modules/export"]);
    expect(shown.json.data.answer).toBeNull();
  });

  test("refuses a report that carries an authority of its own", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);

    const inputPath = await writeInput(workspace, {
      ...questionBody(),
      approval: { action: "worktree-delete", targets: ["everything"] },
    });
    const raised = await runJson(
      workspace,
      [
        "question",
        "raise",
        "--request",
        request(),
        "--attempt",
        crew.attemptId,
        "--input",
        inputPath,
      ],
      crew.worktree,
    );

    expect(raised.exitCode).toBe(2);
    expect(raised.json.reason).toBe("invalid_question_input");
  });

  test("refuses a second open question from one Operative", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    await raise(workspace, crew);

    const second = await raise(workspace, crew, { question: "And what about the header row?" });

    expect(second.exitCode).toBe(4);
    expect(second.json.reason).toBe("question_open");
  });

  test("leaves every other assignment dispatchable", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace, ["21.1", "21.2"]);
    const raised = await raise(workspace, crew);

    const frontier = await runJson(workspace, ["work", "frontier"]);

    expect(frontier.exitCode).toBe(0);
    expect(frontier.json.reason).toBe("frontier_ready");
    const dispatchable = frontier.json.data.dispatchable.map(
      (one: { assignmentId: string }) => one.assignmentId,
    );
    expect(dispatchable).toContain(crew.registered[1]?.assignmentId);
    expect(dispatchable).not.toContain(crew.assignmentId);
    expect(frontier.json.data.questions).toEqual([
      expect.objectContaining({
        questionId: raised.json.data.questionId,
        assignmentId: crew.assignmentId,
        state: "open",
        independentWork: ["The reader tests continue."],
      }),
    ]);

    // A person reading the frontier sees the same waiting question as an agent does.
    const readable = await runOperator(workspace, ["work", "frontier"]);
    expect(readable.stdout).toContain("Waiting on an answer:");
    expect(readable.stdout).toContain(raised.json.data.questionId);
  });
});

describe("operator question answer", () => {
  test("keeps the exact human words apart from the structured reading", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);

    const recorded = await answer(
      workspace,
      crew,
      { questionId: raised.json.data.questionId, revision: 1 },
      { authority: "human-answer" },
    );

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json.reason).toBe("answer_recorded");
    expect(recorded.json.data.authority).toBe("human-answer");

    const shown = await runJson(workspace, [
      "question",
      "show",
      "--question",
      raised.json.data.questionId,
    ]);
    expect(shown.json.data.answer.exactText).toBe(
      "keep the old order, we have readers in the field",
    );
    expect(shown.json.data.answer.interpretation.summary).toBe("Keep the legacy column order.");
    expect(shown.json.data.answer.source).toBeNull();
  });

  test("records a requirement with the source it comes from", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);

    await answer(
      workspace,
      crew,
      { questionId: raised.json.data.questionId, revision: 1 },
      { authority: "requirement" },
    );

    const shown = await runJson(workspace, [
      "question",
      "show",
      "--question",
      raised.json.data.questionId,
    ]);
    expect(shown.json.data.answer.authority).toBe("requirement");
    expect(shown.json.data.answer.source).toEqual({ id: "github:operator#21", revision: "rev-1" });
  });

  test("answers a technical question inside delegated authority", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);

    const recorded = await answer(workspace, crew, {
      questionId: raised.json.data.questionId,
      revision: 1,
    });

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json.data.authority).toBe("operator-decision");
  });

  test("refuses an Operator decision on an ambiguous question, however often it is retried", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew, { escalationTriggers: ["ambiguity"] });
    const question = { questionId: raised.json.data.questionId, revision: 1 };

    const first = await answer(workspace, crew, question);
    const second = await answer(workspace, crew, question);

    expect(first.exitCode).toBe(3);
    expect(first.json.reason).toBe("escalation_required");
    expect(second.exitCode).toBe(3);
    expect(second.json.reason).toBe("escalation_required");

    const escalated = await answer(workspace, crew, question, { authority: "human-answer" });
    expect(escalated.exitCode).toBe(0);
  });

  test("refuses an Operator decision on conflicting explicit requirements", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);

    // A second ticket states the opposite requirement, so no source settles the question.
    const secondPath = await writeInput(workspace, {
      sourceKind: "ticket",
      source: { id: "github:operator#22", revision: "rev-1", tracker: "github" },
      items: [{ ...item({ key: "22.1", title: "Use the new column order" }) }],
    });
    const second = await runJson(workspace, [
      "work",
      "register",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--input",
      secondPath,
    ]);

    const raised = await raise(workspace, crew, {
      question: "Ticket 21 keeps the legacy column order and ticket 22 replaces it.",
      affectedScope: [crew.assignmentId, second.json.data.registered[0].assignmentId],
      escalationTriggers: ["conflicting-requirements", "visible-behavior"],
    });

    const refused = await answer(workspace, crew, {
      questionId: raised.json.data.questionId,
      revision: 1,
    });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.blockers[0].escalationTriggers).toEqual([
      "conflicting-requirements",
      "visible-behavior",
    ]);
  });

  test("refuses a second decision on one question revision", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const question = { questionId: raised.json.data.questionId, revision: 1 };
    await answer(workspace, crew, question);

    const second = await answer(workspace, crew, question, { authority: "human-answer" });

    expect(second.exitCode).toBe(4);
    expect(second.json.reason).toBe("already_answered");
  });
});

describe("operator question deliver", () => {
  test("delivers once, stays pending until acknowledgement, and never sends twice", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 }, { authority: "human-answer" });

    const delivered = await deliver(workspace, crew, questionId);

    expect(delivered.exitCode).toBe(6);
    expect(delivered.json.reason).toBe("answer_delivered");
    const sent = await Bun.file(`${workspace.herdr}/last-prompt`).text();
    expect(sent).toContain(questionId);
    expect(sent).toContain("keep the old order, we have readers in the field");
    expect(sent).toContain("operator question acknowledge");

    await Bun.write(`${workspace.herdr}/last-prompt`, "cleared\n");
    const again = await deliver(workspace, crew, questionId);
    expect(again.exitCode).toBe(6);
    expect(again.json.data.repeated).toBe(true);
    expect(await Bun.file(`${workspace.herdr}/last-prompt`).text()).toBe("cleared\n");

    const acknowledged = await runJson(
      workspace,
      ["question", "acknowledge", "--request", request(), "--question", questionId],
      crew.worktree,
    );
    expect(acknowledged.exitCode).toBe(0);
    expect(acknowledged.json.reason).toBe("question_acknowledged");

    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(frontier.json.data.questions).toEqual([]);
  });

  test("an uncertain delivery blocks another delivery until it is reconciled", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 });

    await Bun.write(`${workspace.herdr}/agent-prompt.garbage`, "");
    const uncertain = await deliver(workspace, crew, questionId);

    expect(uncertain.exitCode).toBe(5);
    expect(uncertain.json.reason).toBe("delivery_uncertain");

    await rm(`${workspace.herdr}/agent-prompt.garbage`);
    const blocked = await deliver(workspace, crew, questionId);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.reason).toBe("reconciliation_required");

    // The writer is live and has not acknowledged, so the effect stays unproven.
    const reconciled = await runJson(workspace, [
      "attempt",
      "reconcile",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(reconciled.exitCode).toBe(5);

    // The Operative's own receipt is the proof the timeout could not give.
    const acknowledged = await runJson(
      workspace,
      ["question", "acknowledge", "--request", request(), "--question", questionId],
      crew.worktree,
    );
    expect(acknowledged.exitCode).toBe(0);

    const settled = await runJson(workspace, [
      "attempt",
      "reconcile",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(settled.exitCode).toBe(0);
  });

  test("refuses to deliver an answer given to an earlier question", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 });

    const revised = await revise(workspace, crew, questionId, 1, {
      question: "Does the export keep the legacy column order and the header?",
    });
    expect(revised.exitCode).toBe(6);
    expect(revised.json.data.revision).toBe(2);
    expect(revised.json.data.droppedAnswerId).not.toBeNull();

    const refused = await deliver(workspace, crew, questionId);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("answer_missing");
  });
});

describe("operator question revise", () => {
  test("refuses to change a question while a delivered answer could still arrive", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 });
    await deliver(workspace, crew, questionId);

    const refused = await revise(workspace, crew, questionId, 1);

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("delivery_started");
  });

  test("a delivery proven to have failed leaves the question free to change", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 });

    await Bun.write(`${workspace.herdr}/agent-prompt.error`, "agent_not_found");
    const failed = await deliver(workspace, crew, questionId);
    expect(failed.exitCode).toBe(1);
    expect(failed.json.reason).toBe("delivery_failed");

    await rm(`${workspace.herdr}/agent-prompt.error`);
    const revised = await revise(workspace, crew, questionId, 1);

    expect(revised.exitCode).toBe(6);
    expect(revised.json.data.revision).toBe(2);
  });
});

describe("what one authority may close", () => {
  test("a recorded requirement cannot settle conflicting requirements", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew, {
      escalationTriggers: ["conflicting-requirements"],
    });
    const questionId = raised.json.data.questionId;

    // Quoting one of the conflicting sources would decide the conflict by choosing a side.
    const quoted = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "requirement" },
    );

    expect(quoted.exitCode).toBe(3);
    expect(quoted.json.reason).toBe("escalation_required");
    expect(quoted.json.blockers[0].escalationTriggers).toEqual(["conflicting-requirements"]);
    expect(quoted.json.blockers[0].authority).toBe("requirement");

    const asked = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "human-answer" },
    );
    expect(asked.exitCode).toBe(0);
  });

  test("a recorded requirement cannot settle an unresolved ambiguity", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew, { escalationTriggers: ["ambiguity"] });

    const quoted = await answer(
      workspace,
      crew,
      { questionId: raised.json.data.questionId, revision: 1 },
      { authority: "requirement" },
    );

    expect(quoted.exitCode).toBe(3);
    expect(quoted.json.reason).toBe("escalation_required");
  });

  test("a recorded requirement settles a subject an approved source states", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew, {
      escalationTriggers: ["visible-behavior", "scope"],
    });

    const quoted = await answer(
      workspace,
      crew,
      { questionId: raised.json.data.questionId, revision: 1 },
      { authority: "requirement" },
    );

    expect(quoted.exitCode).toBe(0);
    expect(quoted.json.data.authority).toBe("requirement");
  });

  test("an earlier requirement cannot be reused into a question that names a conflict", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    const quoted = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "requirement" },
    );
    const answerId = quoted.json.data.answerId;

    await revise(workspace, crew, questionId, 1, {
      escalationTriggers: ["conflicting-requirements"],
    });
    const approved = await grant(workspace, crew, {
      action: "answer-reuse",
      targets: [answerId],
      scope: `question:${questionId}`,
      requestRevision: "2",
      exactText: "reuse it",
    });

    const refused = await reapply(workspace, crew, {
      questionId,
      revision: 2,
      answerId,
      approvalId: approved.json.data.approvalId,
    });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("escalation_required");
  });
});

describe("concurrent delivery", () => {
  test("two deliveries of one answer submit it once", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 });

    const [first, second] = await Promise.all([
      deliver(workspace, crew, questionId),
      deliver(workspace, crew, questionId),
    ]);

    // One of the two claimed the delivery; the other reports what it found, and sends nothing.
    expect([first.json.reason, second.json.reason]).toContain("answer_delivered");

    const calls = (await Bun.file(`${workspace.herdr}/calls.log`).text())
      .split("\n")
      .filter((line) => line.startsWith("agent prompt"));
    // One prompt carried the assignment brief, and exactly one carried the answer.
    expect(calls).toHaveLength(2);
  });
});

describe("operator question escalate", () => {
  test("an Operator escalation refuses a decision the Operative did not flag", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;

    // The Operative declared nothing, so the Operator could settle this alone.
    const decided = await answer(workspace, crew, { questionId, revision: 1 });
    expect(decided.exitCode).toBe(0);

    const escalated = await escalate(workspace, crew, questionId, 1, {
      escalationTriggers: ["scope", "security-permissions"],
      reason: "The change adds a write path the approved scope does not carry.",
    });

    expect(escalated.exitCode).toBe(3);
    expect(escalated.json.reason).toBe("question_escalated");
    expect(escalated.json.data.escalationTriggers).toEqual(["scope", "security-permissions"]);
    expect(escalated.json.data.droppedAnswerId).toBe(decided.json.data.answerId);

    // The decision it dropped cannot be recorded again.
    const refused = await answer(workspace, crew, { questionId, revision: 1 });
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("escalation_required");

    const escalatedAnswer = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "human-answer" },
    );
    expect(escalatedAnswer.exitCode).toBe(0);

    const shown = await runJson(workspace, ["question", "show", "--question", questionId]);
    expect(shown.json.data.operatorEscalation.reason).toBe(
      "The change adds a write path the approved scope does not carry.",
    );
    expect(shown.json.data.report.escalationTriggers).toEqual([]);
  });

  test("an escalation leaves a person's answer standing", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    const human = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "human-answer" },
    );

    const escalated = await escalate(workspace, crew, questionId, 1, {
      escalationTriggers: ["visible-behavior"],
      reason: "The choice changes what an operator sees.",
    });

    expect(escalated.json.data.droppedAnswerId).toBeNull();

    const delivered = await deliver(workspace, crew, questionId);
    expect(delivered.exitCode).toBe(6);
    expect(delivered.json.data.answerId).toBe(human.json.data.answerId);
  });
});

describe("a question after a proven-failed delivery", () => {
  test("can still be escalated, because nothing reached the Operative", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 });

    await Bun.write(`${workspace.herdr}/agent-prompt.error`, "agent_not_found");
    const failed = await deliver(workspace, crew, questionId);
    expect(failed.json.reason).toBe("delivery_failed");
    await rm(`${workspace.herdr}/agent-prompt.error`);

    const escalated = await escalate(workspace, crew, questionId, 1, {
      escalationTriggers: ["security-permissions"],
      reason: "The change needs a permission the approved scope does not carry.",
    });

    expect(escalated.exitCode).toBe(3);
    expect(escalated.json.reason).toBe("question_escalated");
    expect(escalated.json.data.droppedAnswerId).not.toBeNull();
  });
});

describe("a resolved question", () => {
  test("cannot be revised or escalated once the Operative has its answer", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    await answer(workspace, crew, { questionId, revision: 1 });
    await deliver(workspace, crew, questionId);
    await runJson(
      workspace,
      ["question", "acknowledge", "--request", request(), "--question", questionId],
      crew.worktree,
    );

    const revised = await revise(workspace, crew, questionId, 1);
    expect(revised.exitCode).toBe(4);
    expect(revised.json.reason).toBe("question_closed");

    const escalated = await escalate(workspace, crew, questionId, 1, {
      escalationTriggers: ["scope"],
      reason: "A second look says this was a scope question.",
    });
    expect(escalated.exitCode).toBe(4);
    expect(escalated.json.reason).toBe("question_closed");
  });
});

describe("a withdrawn question", () => {
  test("cannot be answered back onto an attempt that ended", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;

    // A replacement ends the former attempt, so the question it raised holds nothing.
    await rm(`${workspace.herdr}/agent-live`);
    const inspected = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(inspected.json.reason).toBe("inspection_required");

    const replaced = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
      "--inspection",
      inspected.json.blockers[0].identity,
    ]);
    expect(replaced.json.reason).toBe("attempt_replaced");

    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(frontier.json.data.questions).toEqual([]);

    const refused = await answer(workspace, crew, { questionId, revision: 1 });

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("question_closed");

    // It stays out of the frontier, so no dead attempt is reported as waiting on an answer.
    const after = await runJson(workspace, ["work", "frontier"]);
    expect(after.json.data.questions).toEqual([]);
  });
});

describe("accepted completion", () => {
  test("waits for the answer to be acknowledged before the result is accepted", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;

    async function accept() {
      return runJson(workspace, [
        "work",
        "accept",
        "--request",
        request(),
        "--owner-token",
        crew.ownerToken,
        "--assignment",
        crew.assignmentId,
        "--attempt",
        crew.attemptId,
        "--revision",
        String(crew.assignmentRevision),
      ]);
    }

    const blocked = await accept();
    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.reason).toBe("question_open");

    await answer(workspace, crew, { questionId, revision: 1 });
    await deliver(workspace, crew, questionId);

    // Delivery is not receipt, so the work still waits.
    expect((await accept()).exitCode).toBe(3);

    await runJson(
      workspace,
      ["question", "acknowledge", "--request", request(), "--question", questionId],
      crew.worktree,
    );

    const accepted = await accept();
    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
  });
});

describe("operator question reapply", () => {
  test("reuses an earlier answer only under an approval that names it", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    const recorded = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "human-answer" },
    );
    const answerId = recorded.json.data.answerId;

    await revise(workspace, crew, questionId, 1, {
      affectedScope: ["modules/export", "modules/report"],
    });

    const withoutApproval = await runJson(workspace, [
      "question",
      "reapply",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--question",
      questionId,
      "--revision",
      "2",
      "--answer",
      answerId,
      "--approval",
      "not-an-approval",
    ]);
    expect(withoutApproval.exitCode).toBe(3);
    expect(withoutApproval.json.reason).toBe("unknown_approval");

    // An approval bound to the earlier revision does not reach the changed question.
    const stale = await grant(workspace, crew, {
      action: "answer-reuse",
      targets: [answerId],
      scope: `question:${questionId}`,
      requestRevision: "1",
      exactText: "yes, that answer still holds",
    });
    const mismatched = await runJson(workspace, [
      "question",
      "reapply",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--question",
      questionId,
      "--revision",
      "2",
      "--answer",
      answerId,
      "--approval",
      stale.json.data.approvalId,
    ]);
    expect(mismatched.exitCode).toBe(3);
    expect(mismatched.json.reason).toBe("approval_mismatch");
    expect(mismatched.json.blockers[0].field).toBe("request-revision");

    const approved = await grant(workspace, crew, {
      action: "answer-reuse",
      targets: [answerId],
      scope: `question:${questionId}`,
      requestRevision: "2",
      exactText: "yes, that answer still holds",
    });
    const reused = await runJson(workspace, [
      "question",
      "reapply",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--question",
      questionId,
      "--revision",
      "2",
      "--answer",
      answerId,
      "--approval",
      approved.json.data.approvalId,
    ]);
    expect(reused.exitCode).toBe(0);
    expect(reused.json.data.reusedFromId).toBe(answerId);
    expect(reused.json.data.authority).toBe("human-answer");

    const shown = await runJson(workspace, ["question", "show", "--question", questionId]);
    expect(shown.json.data.answer.exactText).toBe(
      "keep the old order, we have readers in the field",
    );
  });

  test("refuses to reuse an Operator decision once the question needs the user", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    const recorded = await answer(workspace, crew, { questionId, revision: 1 });
    const answerId = recorded.json.data.answerId;

    await revise(workspace, crew, questionId, 1, { escalationTriggers: ["visible-behavior"] });

    const approved = await grant(workspace, crew, {
      action: "answer-reuse",
      targets: [answerId],
      scope: `question:${questionId}`,
      requestRevision: "2",
      exactText: "reuse it",
    });
    const refused = await runJson(workspace, [
      "question",
      "reapply",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--question",
      questionId,
      "--revision",
      "2",
      "--answer",
      answerId,
      "--approval",
      approved.json.data.approvalId,
    ]);

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("escalation_required");
  });
});

describe("a revoked reuse approval", () => {
  test("stops the reuse it was granted for", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    const recorded = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "human-answer" },
    );
    const answerId = recorded.json.data.answerId;
    await revise(workspace, crew, questionId, 1, { affectedScope: ["modules/report"] });

    const approved = await grant(workspace, crew, {
      action: "answer-reuse",
      targets: [answerId],
      scope: `question:${questionId}`,
      requestRevision: "2",
      exactText: "yes, that answer still holds",
    });
    const revoked = await runJson(workspace, [
      "approval",
      "revoke",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--approval",
      approved.json.data.approvalId,
      "--revision",
      "1",
    ]);
    expect(revoked.json.reason).toBe("approval_revoked");

    const refused = await reapply(workspace, crew, {
      questionId,
      revision: 2,
      answerId,
      approvalId: approved.json.data.approvalId,
    });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("approval_revoked");

    // The question still holds no answer, so nothing reaches the Operative on a dead approval.
    const shown = await runJson(workspace, ["question", "show", "--question", questionId]);
    expect(shown.json.data.answer).toBeNull();
  });
});

describe("reuse across a rewritten question", () => {
  test("rests on the approval a person gave for that exact revision", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    const recorded = await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "human-answer" },
    );
    const answerId = recorded.json.data.answerId;

    // Nothing of the first question survives except its identity.
    await revise(workspace, crew, questionId, 1, {
      question: "Which timezone does the export stamp its rows in?",
      affectedScope: ["modules/report"],
      recommendation: "Stamp them in UTC.",
    });

    // The CLI does not judge whether the old words still fit; a person does, and says so here.
    const approved = await grant(workspace, crew, {
      action: "answer-reuse",
      targets: [answerId],
      scope: `question:${questionId}`,
      requestRevision: "2",
      exactText: "I read the new question. That answer still covers it.",
    });
    const reused = await reapply(workspace, crew, {
      questionId,
      revision: 2,
      answerId,
      approvalId: approved.json.data.approvalId,
    });

    expect(reused.exitCode).toBe(0);
    expect(reused.json.data.approvalId).toBe(approved.json.data.approvalId);

    // The reuse names the approval that stands behind it, so a later session can check it.
    const shown = await runJson(workspace, ["question", "show", "--question", questionId]);
    expect(shown.json.data.answer.reusedFromId).toBe(answerId);
    expect(shown.json.data.answer.approvalId).toBe(approved.json.data.approvalId);
  });
});

describe("operator approval", () => {
  test("binds one exact action, target, scope, and request revision", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    await grant(workspace, crew);

    const exact = await check(workspace);
    expect(exact.exitCode).toBe(0);
    expect(exact.json.reason).toBe("approval_matched");

    const broader = await check(workspace, { targets: ["bun test", "git push"] });
    expect(broader.exitCode).toBe(3);
    expect(broader.json.reason).toBe("approval_missing");

    const changedTarget = await check(workspace, { targets: ["git push"] });
    expect(changedTarget.exitCode).toBe(3);

    const changedScope = await check(workspace, { scope: "workflow" });
    expect(changedScope.exitCode).toBe(3);

    const changedRevision = await check(workspace, { requestRevision: "2" });
    expect(changedRevision.exitCode).toBe(3);
  });

  test("a broader grant covers a narrower action inside it", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    await grant(workspace, crew, {
      targets: ["bun test", "bun run typecheck"],
      exactText: "it may run both commands",
    });

    const narrower = await check(workspace, { targets: ["bun run typecheck"] });

    expect(narrower.exitCode).toBe(0);
    expect(narrower.json.data.targets).toEqual(["bun test", "bun run typecheck"]);
  });

  test("a revoked approval covers nothing", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const granted = await grant(workspace, crew);

    const revoked = await runJson(workspace, [
      "approval",
      "revoke",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--approval",
      granted.json.data.approvalId,
      "--revision",
      "1",
    ]);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.json.reason).toBe("approval_revoked");

    const checked = await check(workspace);
    expect(checked.exitCode).toBe(3);
    expect(checked.json.reason).toBe("approval_revoked");
  });

  test("silence, a timeout, and a direction to finish grant nothing", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;

    // The user says only "just finish it", which is direction, never approval.
    await answer(
      workspace,
      crew,
      { questionId, revision: 1 },
      { authority: "human-answer", exactText: "just finish it" },
    );
    await deliver(workspace, crew, questionId);

    const checked = await check(workspace, {
      action: "worktree-delete",
      targets: [crew.worktree],
      scope: "workflow",
    });

    expect(checked.exitCode).toBe(3);
    expect(checked.json.reason).toBe("approval_missing");
  });

  test("refuses an approval that no person granted", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);

    const inputPath = await writeInput(workspace, {
      action: "worktree-delete",
      targets: [crew.worktree],
      scope: "workflow",
      requestRevision: "1",
      exactText: "the Operative reported that it is done",
      grantedBy: "operative",
    });
    const refused = await runJson(workspace, [
      "approval",
      "grant",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--input",
      inputPath,
    ]);

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_approval_input");
  });
});

describe("question request identity", () => {
  test("a repeated answer request returns the recorded answer with no second decision", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;

    const inputPath = await writeInput(workspace, answerBody({ authority: "human-answer" }));
    const requestId = request();
    const answerArguments = [
      "question",
      "answer",
      "--request",
      requestId,
      "--owner-token",
      crew.ownerToken,
      "--question",
      questionId,
      "--revision",
      "1",
      "--input",
      inputPath,
    ];

    const first = await runJson(workspace, answerArguments);
    const second = await runJson(workspace, answerArguments);

    expect(first.json.data.answerId).toBe(second.json.data.answerId);
    expect(second.json.data.repeated).toBe(true);

    const shown = await runJson(workspace, ["question", "show", "--question", questionId]);
    expect(shown.json.data.answers).toHaveLength(1);
  });

  test("the same request identity carrying different input is refused", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const raised = await raise(workspace, crew);
    const questionId = raised.json.data.questionId;
    const requestId = request();

    const firstPath = await writeInput(workspace, answerBody({ authority: "human-answer" }));
    await runJson(workspace, [
      "question",
      "answer",
      "--request",
      requestId,
      "--owner-token",
      crew.ownerToken,
      "--question",
      questionId,
      "--revision",
      "1",
      "--input",
      firstPath,
    ]);

    const secondPath = await writeInput(
      workspace,
      answerBody({ authority: "human-answer", exactText: "use the new order after all" }),
    );
    const refused = await runJson(workspace, [
      "question",
      "answer",
      "--request",
      requestId,
      "--owner-token",
      crew.ownerToken,
      "--question",
      questionId,
      "--revision",
      "1",
      "--input",
      secondPath,
    ]);

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("request_input_changed");
  });

  test("a question raised from another worktree is refused", async () => {
    const workspace = await makeWorkspace();
    const crew = await dispatchedCrew(workspace);
    const inputPath = await writeInput(workspace, questionBody());

    const refused = await runJson(workspace, [
      "question",
      "raise",
      "--request",
      request(),
      "--attempt",
      crew.attemptId,
      "--input",
      inputPath,
    ]);

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("attempt_reference_missing");
  });
});
