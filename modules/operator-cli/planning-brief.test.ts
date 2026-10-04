import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  commitArtifact,
  frontierEntry,
  makeReviewWorkspace,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";
import { registerSource, workspaceTarget } from "./source-fixture.ts";
import {
  headCommit,
  passBaseGate,
  requestId as request,
  runJson,
  stopFakeAgents,
  workspaces,
} from "./workspace-fixture.ts";

// These tests create Git worktrees and run several CLI processes under the parallel CI gate.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 120_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const BRIEF = ".operator/local/brief.md";
const HEADING = "## Planning records";

/** The planning records section of one brief or spec copy, or null when it has none. */
function planningSection(text: string): string | null {
  const start = text.indexOf(HEADING);
  if (start === -1) {
    return null;
  }
  const end = text.indexOf("\n## ", start + HEADING.length);
  return text.slice(start, end === -1 ? undefined : end);
}

async function ownCrew(workspace: Workspace): Promise<string> {
  const owned = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    "operator-session",
  ]);
  return owned.json.data.ownerToken;
}

/**
 * Two planning items in a chain and one task under them: 30.3 depends on 30.2, and 30.2 depends
 * on 30.1. So 30.1 is two steps above the task.
 */
async function registerChain(workspace: Workspace, ownerToken: string) {
  const item = (
    key: string,
    kind: "production" | "planning",
    title: string,
    dependsOn: string[],
  ) => ({
    key,
    title,
    body: title,
    kind,
    permissions: { writePaths: ["docs/"], allowedCommands: ["bun test"], network: false },
    dependsOn: dependsOn.map((one) => ({ key: one })),
  });
  const registered = await registerSource(workspaceTarget(workspace), ownerToken, {
    sourceKind: "specification",
    parent: 30,
    items: [
      item("30.1", "planning", "Decide the store", []),
      item("30.2", "planning", "Decide the rollout", ["30.1"]),
      item("30.3", "production", "Build the rollout", ["30.2"]),
    ],
  });
  expect(registered.exitCode).toBe(0);
  return registered.keys;
}

/** Accepts one planning item with one human answer and one text artifact. */
async function decide(
  workspace: Workspace,
  ownerToken: string,
  options: { assignmentId: string; revision: number; question: string; answer: string },
) {
  const artifactText = `# Resolution\n\n${options.question}\n\n${options.answer}\n`;
  const artifactPath = `${workspace.root}/inputs/resolution-${crypto.randomUUID()}.md`;
  await Bun.write(artifactPath, artifactText);
  const artifactIdentity = ContentIdentity.ofText(artifactText);

  const accepted = await runJson(workspace, [
    "work",
    "accept",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    String(options.revision),
    "--input",
    await writeInput(workspace, {
      entries: [
        {
          question: options.question,
          escalationTriggers: [],
          authority: "human-answer",
          exactText: options.answer,
          interpretation: {
            summary: options.answer,
            directives: [`Follow: ${options.answer}`],
            appliesTo: ["The work that depends on this decision."],
          },
        },
      ],
      artifacts: [{ name: "resolution", path: artifactPath, contentIdentity: artifactIdentity }],
    }),
  ]);
  expect(accepted.json.reason).toBe("assignment_accepted");
  return {
    recordId: accepted.json.data.planningRecordId as string,
    revision: accepted.json.data.revision as number,
    artifactIdentity,
  };
}

/** Claims and launches one production assignment, as a producer the fixture helpers accept. */
async function launch(
  workspace: Workspace,
  ownerToken: string,
  options: { assignmentId: string; worktreePath: string },
) {
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    "1",
  ]);
  const attemptId = claimed.json.data.attemptId as string;
  const baseCommit = await headCommit(workspace);
  // The first code dispatch of a source starts only from a base that passed the project gate.
  await passBaseGate(workspace, { ownerToken, attemptId, commit: baseCommit });
  const dispatched = await runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--attempt",
    attemptId,
    "--commit",
    baseCommit,
    "--worktree",
    options.worktreePath,
  ]);
  expect(dispatched.json.outcome).toBe("pending");

  return {
    ownerToken,
    assignmentId: options.assignmentId,
    attemptId,
    worktreePath: options.worktreePath,
    baseCommit,
    assignmentRevision: claimed.json.data.revision as number,
    dispatched: dispatched.json,
    dependents: new Map<string, string>(),
    sourceRevision: sourceRevisionOf(workspace, options.assignmentId),
  };
}

/** The source revision an assignment was registered under, which its submission states. */
function sourceRevisionOf(workspace: Workspace, assignmentId: string): string {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  const row = sqlite
    .query("select source_revision from assignments where id = ?")
    .get(assignmentId) as { source_revision: string };
  sqlite.close();
  return row.source_revision;
}

async function acknowledge(
  workspace: Workspace,
  producer: { attemptId: string; worktreePath: string },
) {
  const acknowledged = await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", producer.attemptId],
    producer.worktreePath,
  );
  expect(acknowledged.exitCode).toBe(0);
}

async function decidedChain(workspace: Workspace) {
  const ownerToken = await ownCrew(workspace);
  const ids = await registerChain(workspace, ownerToken);
  const store = await decide(workspace, ownerToken, {
    assignmentId: ids.get("30.1") ?? "",
    revision: 1,
    question: "Which store holds the rollout state?",
    answer: "Keep it in SQLite.",
  });
  const rollout = await decide(workspace, ownerToken, {
    assignmentId: ids.get("30.2") ?? "",
    revision: 1,
    question: "In which order do we roll out?",
    answer: "Roll out the readers first.",
  });
  return { ownerToken, ids, store, rollout };
}

/** Invalidates the rollout decision and accepts it again with a changed record. */
async function decideAgain(
  workspace: Workspace,
  ownerToken: string,
  options: { assignmentId: string; revision: number },
) {
  const invalidated = await runJson(workspace, [
    "work",
    "invalidate",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    String(options.revision),
    "--input",
    await writeInput(workspace, {
      summary: "The rollout order was wrong.",
      evidence: "The writers must go first.",
      foundBy: "the Operator on 30.3",
    }),
  ]);
  expect(invalidated.json.reason).toBe("result_invalidated");
  return decide(workspace, ownerToken, {
    assignmentId: options.assignmentId,
    revision: invalidated.json.data.revision,
    question: "In which order do we roll out?",
    answer: "Roll out the writers first.",
  });
}

describe("a planning record reaches its direct dependents", () => {
  test("the brief of a direct dependent carries the record, and two steps down does not", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { ownerToken, ids, store, rollout } = await decidedChain(workspace);

    const producer = await launch(workspace, ownerToken, {
      assignmentId: ids.get("30.3") ?? "",
      worktreePath: `${workspace.root}/operative`,
    });
    const brief = await Bun.file(`${producer.worktreePath}/${BRIEF}`).text();
    const section = planningSection(brief);

    expect(section).not.toBeNull();
    expect(section).toContain(`Decide the rollout (${ids.get("30.2")})`);
    expect(section).toContain(rollout.recordId);
    expect(section).toContain("In which order do we roll out?");
    expect(section).toContain("> Roll out the readers first.");
    expect(section).toContain(`.operator/local/planning/${rollout.artifactIdentity}`);
    // 30.1 is two steps above the task, so neither its words nor its artifact reach it.
    expect(brief).not.toContain(store.recordId);
    expect(brief).not.toContain("Which store holds the rollout state?");
    expect(brief).not.toContain(store.artifactIdentity);

    const copied = Bun.file(
      `${producer.worktreePath}/.operator/local/planning/${rollout.artifactIdentity}`,
    );
    expect(ContentIdentity.ofBytes(new Uint8Array(await copied.arrayBuffer()))).toBe(
      rollout.artifactIdentity,
    );
    expect(
      await Bun.file(
        `${producer.worktreePath}/.operator/local/planning/${store.artifactIdentity}`,
      ).exists(),
    ).toBe(false);
  });

  test("a recovery restores the same record text after a new acceptance", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { ownerToken, ids, rollout } = await decidedChain(workspace);
    // The agent does not start, so the next dispatch of the attempt recovers the launch.
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");
    const assignmentId = ids.get("30.3") ?? "";
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
    const attemptId = claimed.json.data.attemptId as string;
    const baseCommit = await headCommit(workspace);
    await passBaseGate(workspace, { ownerToken, attemptId, commit: baseCommit });
    const dispatch = async (extra: string[]) =>
      runJson(workspace, [
        "attempt",
        "dispatch",
        "--request",
        request(),
        "--owner-token",
        ownerToken,
        "--attempt",
        attemptId,
        ...extra,
      ]);
    const worktreePath = `${workspace.root}/operative`;
    const failed = await dispatch(["--commit", baseCommit, "--worktree", worktreePath]);
    expect(failed.json.reason).toBe("dispatch_stage_failed");
    const first = planningSection(await Bun.file(`${worktreePath}/${BRIEF}`).text());
    // A later record of the decision. An acceptance through the CLI also pauses the dependent and
    // moves its revision, which a recovery refuses for itself, so only the record is written here.
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    sqlite
      .query(
        `insert into planning_records
           select 'later-record', assignment_id, assignment_revision + 2,
             replace(entries, 'Roll out the readers first.', 'Roll out the writers first.'),
             artifacts, 'later-identity', recorded_at || 'z'
           from planning_records where id = ?`,
      )
      .run(rollout.recordId);
    sqlite.close();
    await Bun.$`rm ${workspace.herdr}/agent-start.error`.quiet();

    const recovered = await dispatch([]);

    expect(recovered.json.outcome).toBe("pending");
    const brief = await Bun.file(`${worktreePath}/${BRIEF}`).text();
    expect(first).not.toBeNull();
    expect(planningSection(brief)).toBe(first);
    expect(brief).not.toContain("later-record");
  });

  test("a replacement attempt receives the same record text after a new acceptance", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { ownerToken, ids, rollout } = await decidedChain(workspace);
    const producer = await launch(workspace, ownerToken, {
      assignmentId: ids.get("30.3") ?? "",
      worktreePath: `${workspace.root}/operative`,
    });
    const first = planningSection(await Bun.file(`${producer.worktreePath}/${BRIEF}`).text());
    // A new decision is accepted while the attempt runs, and the replacement keeps the old one.
    const changed = await decideAgain(workspace, ownerToken, {
      assignmentId: ids.get("30.2") ?? "",
      revision: rollout.revision,
    });

    await stopFakeAgents(workspace);
    const inspected = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
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
      ownerToken,
      "--attempt",
      producer.attemptId,
      "--inspection",
      inspected.json.data.identity,
    ]);
    expect(replaced.exitCode).toBe(0);
    const attemptId = replaced.json.data.attemptId as string;
    const relaunched = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--attempt",
      attemptId,
    ]);
    expect(relaunched.json.outcome).toBe("pending");

    const second = await Bun.file(`${producer.worktreePath}/${BRIEF}`).text();
    expect(second).toContain(`attempt ${attemptId}`);
    expect(first).not.toBeNull();
    expect(planningSection(second)).toBe(first);
    expect(second).not.toContain(changed.recordId);
    expect(second).not.toContain("Roll out the writers first.");
  });

  test("a dependent of planning work that an earlier release accepted states no recorded decision", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { ownerToken, ids, rollout } = await decidedChain(workspace);
    // An earlier release accepted planning work with no record, and the migration adds none.
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    sqlite.query("delete from planning_records where id = ?").run(rollout.recordId);
    sqlite.close();

    const producer = await launch(workspace, ownerToken, {
      assignmentId: ids.get("30.3") ?? "",
      worktreePath: `${workspace.root}/operative`,
    });
    const section = planningSection(await Bun.file(`${producer.worktreePath}/${BRIEF}`).text());

    expect(section).toContain(`Decide the rollout (${ids.get("30.2")})`);
    expect(section).toContain("has no recorded decision");
    expect(section).not.toContain("In which order do we roll out?");
  });

  test("the review spec copy holds the records of the producer brief, also after a new decision", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const { ownerToken, ids, rollout } = await decidedChain(workspace);
    const producer = await launch(workspace, ownerToken, {
      assignmentId: ids.get("30.3") ?? "",
      worktreePath: `${workspace.root}/operative`,
    });
    await acknowledge(workspace, producer);
    const launched = planningSection(await Bun.file(`${producer.worktreePath}/${BRIEF}`).text());

    // The decision changes while the dependent runs. The running dependent keeps the brief it
    // was launched with, so its review checks it against the decision that it followed.
    const changed = await decideAgain(workspace, ownerToken, {
      assignmentId: ids.get("30.2") ?? "",
      revision: rollout.revision,
    });

    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    // The pause and the release each move the revision of the dependent.
    const current = await frontierEntry(workspace, producer.assignmentId);
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, { assignmentRevision: current.entry.revision }),
    );
    expect(submitted.json.reason).toBe("result_submitted");
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const spec = await Bun.file(`${reviewer.worktreePath}/.operator/local/review/spec.md`).text();

    expect(launched).not.toBeNull();
    expect(planningSection(spec)).toBe(launched);
    expect(spec).not.toContain(changed.recordId);
    expect(spec).not.toContain("Roll out the writers first.");
    const copied = Bun.file(
      `${reviewer.worktreePath}/.operator/local/planning/${rollout.artifactIdentity}`,
    );
    expect(ContentIdentity.ofBytes(new Uint8Array(await copied.arrayBuffer()))).toBe(
      rollout.artifactIdentity,
    );
  });
});
