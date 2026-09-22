import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  headCommit,
  herdrCalls,
  requestId as request,
  runJson,
  runOperator,
  type Workspace,
  workspaces,
} from "./workspace-fixture.ts";
import {
  acceptProduction,
  blockThenReplace,
  commitArtifact,
  delegateRework,
  grantDirection,
  makeReviewWorkspace,
  relaunchReviewer,
  reportBody,
  reportReview,
  startProducer,
  startRework,
  startReviewer,
  submissionBody,
  submit,
} from "./review-cycle-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

async function makeWorkspace(config: unknown = { crew: { host: "claude-code" } }) {
  return fixtures.make({ config });
}

/** A workspace that also carries the review skill one reviewer must load. */
async function makeReviewingWorkspace(options: { reviewSkill?: boolean } = {}) {
  return makeReviewWorkspace(fixtures, options);
}

async function calls(workspace: Workspace): Promise<string[]> {
  return herdrCalls(workspace);
}

async function claimedAttempt(workspace: Workspace) {
  const owned = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    "operator-session",
  ]);
  const ownerToken = owned.json.data.ownerToken;

  const input = {
    sourceKind: "specification",
    source: { id: "github:operator#20", revision: "rev-1", tracker: "github" },
    items: [
      {
        key: "20.1",
        title: "Dispatch one Operative",
        kind: "production",
        approvedScope: "Build the dispatch path.",
        acceptanceRequirements: ["The quality gate passes."],
        permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
        fixedInputs: [{ name: "brief", kind: "value", value: "the brief", contentIdentity: null }],
        dependsOn: [],
      },
    ],
  };
  const inputPath = `${workspace.root}/work.json`;
  await Bun.write(inputPath, JSON.stringify(input));
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
  const assignmentId = registered.json.data.registered[0].assignmentId;

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

  return { ownerToken, assignmentId, attemptId: claimed.json.data.attemptId };
}

async function dispatch(
  workspace: Workspace,
  crew: { ownerToken: string; attemptId: string },
  extra: string[] = [],
) {
  return runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    crew.ownerToken,
    "--attempt",
    crew.attemptId,
    "--commit",
    await headCommit(workspace),
    "--worktree",
    `${workspace.root}/operative`,
    ...extra,
  ]);
}

// A snapshot a newer release wrote can hold a shape this release cannot read.
async function damageSnapshot(workspace: Workspace, attemptId: string) {
  const path = `${workspace.repo}/.operator/local/crew-state.sqlite`;
  await Bun.$`bun -e ${`
    const { Database } = require("bun:sqlite");
    const db = new Database(${JSON.stringify(path)});
    db.query("update attempt_dispatch set snapshot = ? where attempt_id = ?").run(
      ${JSON.stringify('{"selection":{"crew":{"host":"claude-code"}}}')},
      ${JSON.stringify(attemptId)},
    );
    db.close();
  `}`.quiet();
}

describe("operator attempt dispatch", () => {
  test("prepares an isolated worktree and stays pending until the Operative acknowledges", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.exitCode).toBe(6);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect(dispatched.json.data.stage).toBe("prompt_delivery");
    expect(dispatched.json.data.agentHost).toBe("claude-code");
    expect(dispatched.json.data.operations.map((one: { state: string }) => one.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);

    const worktree = `${workspace.root}/operative`;
    expect(await Bun.file(`${worktree}/.operator/config.json`).exists()).toBe(true);
    expect(await Bun.file(`${worktree}/.operator/local/release.json`).exists()).toBe(true);
    expect(await Bun.file(`${worktree}/.operator/local/bun.lock`).exists()).toBe(true);
    expect(await Bun.file(`${worktree}/.claude/skills/operator/SKILL.md`).exists()).toBe(true);

    const brief = await Bun.file(`${worktree}/.operator/local/brief.md`).text();
    expect(brief).toContain(crew.attemptId);
    expect(brief).toContain(crew.assignmentId);
    expect(brief).toContain("Build the dispatch path.");
    expect(brief).toContain("The quality gate passes.");
    expect(brief).toContain("modules/");
    expect(brief).toContain("operator attempt acknowledge");

    const reference = await Bun.file(`${worktree}/.operator/local/attempt.json`).json();
    expect(reference.controllingCheckout).toBe(workspace.repo);
    expect(reference.attemptId).toBe(crew.attemptId);

    const prompt = await Bun.file(`${workspace.herdr}/last-prompt`).text();
    expect(prompt).toContain(crew.attemptId);
    expect(prompt).toContain(".operator/local/brief.md");

    const acknowledged = await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", crew.attemptId],
      worktree,
    );
    expect(acknowledged.exitCode).toBe(0);
    expect(acknowledged.json.reason).toBe("attempt_acknowledged");

    const shown = await runJson(workspace, ["attempt", "show", "--attempt", crew.attemptId]);
    expect(shown.json.data.stage).toBe("acknowledged");
  });

  test("copies no credential and no crew state into the worktree", async () => {
    const workspace = await makeWorkspace();
    await Bun.write(`${workspace.repo}/.env`, "TOKEN=secret\n");
    await Bun.write(`${workspace.repo}/.operator/local/credentials.json`, `{"token":"secret"}\n`);
    const crew = await claimedAttempt(workspace);

    await dispatch(workspace, crew);

    const worktree = `${workspace.root}/operative`;
    expect(await Bun.file(`${worktree}/.env`).exists()).toBe(false);
    expect(await Bun.file(`${worktree}/.operator/local/credentials.json`).exists()).toBe(false);
    expect(await Bun.file(`${worktree}/.operator/local/crew-state.sqlite`).exists()).toBe(false);
  });

  test("uses only read-only inspection and the launch calls it records", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);
    await runJson(workspace, [
      "attempt",
      "reconcile",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);

    const log = await calls(workspace);
    const groups = [...new Set(log.map((line) => line.split(" ").slice(0, 2).join(" ")))];
    expect(groups.toSorted()).toEqual([
      "agent get",
      "agent prompt",
      "agent start",
      "pane list",
      "worktree create",
      "worktree list",
    ]);
  });

  test("refuses a request that restates a different commit, branch, or checkout", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-start.error`);

    const restated = await dispatch(workspace, crew, ["--branch", "operator/somewhere-else"]);
    expect(restated.exitCode).toBe(4);
    expect(restated.json.reason).toBe("dispatch_plan_changed");
    expect(restated.json.blockers[0].computed).toBe("operator/somewhere-else");
  });

  test("refuses a dispatch that names no commit", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);

    const result = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.json.reason).toBe("commit_required");
  });

  test("refuses a dispatch with no named crew host", async () => {
    const workspace = await makeWorkspace({ operator: {}, crew: {} });
    const crew = await claimedAttempt(workspace);

    const result = await dispatch(workspace, crew);
    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("host_unnamed");
  });
});

describe("interrupted dispatch", () => {
  test("records a failed launch and runs that stage again on the next dispatch", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");

    const failed = await dispatch(workspace, crew);
    expect(failed.exitCode).toBe(1);
    expect(failed.json.reason).toBe("dispatch_stage_failed");
    expect(failed.json.blockers[0].stage).toBe("agent_start");

    await rm(`${workspace.herdr}/agent-start.error`);
    const retried = await dispatch(workspace, crew);
    expect(retried.exitCode).toBe(6);
    expect(retried.json.data.stage).toBe("prompt_delivery");
    expect(
      (await calls(workspace)).filter((line) => line.startsWith("worktree create")),
    ).toHaveLength(1);
  });

  test("runs a failed stage again under the request identity that recorded it", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");
    const requestId = request();
    const args = [
      "attempt",
      "dispatch",
      "--request",
      requestId,
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
      "--commit",
      await headCommit(workspace),
      "--worktree",
      `${workspace.root}/operative`,
    ];

    const failed = await runJson(workspace, args);
    expect(failed.exitCode).toBe(1);

    await rm(`${workspace.herdr}/agent-start.error`);
    const retried = await runJson(workspace, args);
    expect(retried.exitCode).toBe(6);
    expect(retried.json.data.stage).toBe("prompt_delivery");
    expect(
      retried.json.data.operations.find((one: { kind: string }) => one.kind === "agent_start")
        .state,
    ).toBe("succeeded");
  });

  test("blocks a launch when the fixed inputs cannot be restored into the checkout", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/block-brief`, "");

    const failed = await dispatch(workspace, crew);
    expect(failed.exitCode).toBe(1);
    expect(failed.json.blockers[0].stage).toBe("input_preparation");
    expect((await calls(workspace)).some((line) => line.startsWith("agent start"))).toBe(false);
  });

  test("holds an unanswered launch open until it is reconciled", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.garbage`, "");

    const uncertain = await dispatch(workspace, crew);
    expect(uncertain.exitCode).toBe(5);
    expect(uncertain.json.reason).toBe("dispatch_stage_uncertain");

    await rm(`${workspace.herdr}/agent-start.garbage`);
    const blocked = await dispatch(workspace, crew);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.reason).toBe("reconciliation_required");
    expect(blocked.json.blockers[0].stage).toBe("agent_start");
    expect((await calls(workspace)).filter((line) => line.startsWith("agent start"))).toHaveLength(
      1,
    );
  });

  test("reconciles an unanswered launch from the agent Herdr actually holds", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.garbage`, "");
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-start.garbage`);
    // The fake records a live agent, so the unanswered start did reach Herdr.
    await Bun.write(`${workspace.herdr}/agent-live`, "operative");

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
    expect(reconciled.exitCode).toBe(0);
    expect(reconciled.json.reason).toBe("attempt_reconciled");
    expect(reconciled.json.data.stage).toBe("agent_start");

    const resumed = await dispatch(workspace, crew);
    expect(resumed.exitCode).toBe(6);
    expect((await calls(workspace)).filter((line) => line.startsWith("agent start"))).toHaveLength(
      1,
    );
  });
});

describe("uncertain prompt delivery", () => {
  test("keeps an unproven delivery open while the writer is live", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-prompt.garbage`, "");

    const uncertain = await dispatch(workspace, crew);
    expect(uncertain.exitCode).toBe(5);
    expect(uncertain.json.blockers[0].stage).toBe("prompt_delivery");

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
    expect(reconciled.json.blockers[0].kind).toBe("prompt_delivery");
    expect((await calls(workspace)).filter((line) => line.startsWith("agent prompt"))).toHaveLength(
      1,
    );
  });

  test("settles an unproven delivery once the Operative acknowledges it", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-prompt.garbage`, "");
    await dispatch(workspace, crew);

    const acknowledged = await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", crew.attemptId],
      `${workspace.root}/operative`,
    );
    expect(acknowledged.exitCode).toBe(0);

    const shown = await runJson(workspace, ["attempt", "show", "--attempt", crew.attemptId]);
    expect(shown.json.data.stage).toBe("acknowledged");
    expect(
      shown.json.data.operations.find((one: { kind: string }) => one.kind === "prompt_delivery")
        .state,
    ).toBe("succeeded");
  });

  test("treats a stopped writer as proof that the brief never landed", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-prompt.garbage`, "");
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-live`);

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
    expect(reconciled.exitCode).toBe(0);
    expect(
      reconciled.json.data.findings.find((one: { kind: string }) => one.kind === "prompt_delivery")
        .state,
    ).toBe("failed");
  });
});

describe("acknowledgement", () => {
  test("refuses an acknowledgement from a directory that holds no attempt reference", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);

    const result = await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", crew.attemptId],
      workspace.repo,
    );
    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("attempt_reference_missing");
  });

  test("refuses an acknowledgement that names another attempt", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);

    const result = await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", crypto.randomUUID()],
      `${workspace.root}/operative`,
    );
    expect(result.exitCode).toBe(4);
    expect(result.json.reason).toBe("attempt_reference_mismatch");
  });
});

describe("snapshot restoration", () => {
  test("refuses to launch an attempt whose recorded inputs drifted", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");
    await dispatch(workspace, crew);

    await Bun.write(
      `${workspace.repo}/.operator/config.json`,
      `${JSON.stringify({ crew: { host: "opencode" } })}\n`,
    );
    await rm(`${workspace.herdr}/agent-start.error`);

    const drifted = await dispatch(workspace, crew);
    expect(drifted.exitCode).toBe(4);
    expect(drifted.json.reason).toBe("snapshot_drift");
    expect(drifted.json.blockers.map((one: { input: string }) => one.input)).toContain(
      "selection.crew.host",
    );
  });

  test("refuses to launch an attempt whose recorded snapshot cannot be read", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-start.error`);
    await damageSnapshot(workspace, crew.attemptId);

    const blocked = await dispatch(workspace, crew);
    expect(blocked.exitCode).toBe(4);
    expect(blocked.json.reason).toBe("snapshot_unreadable");
    expect(blocked.json.blockers[0].attemptId).toBe(crew.attemptId);
    expect(blocked.json.blockers[0].detail).toContain("release");
    expect((await calls(workspace)).filter((line) => line.startsWith("agent start"))).toHaveLength(
      1,
    );

    const readable = await runOperator(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
      "--commit",
      await headCommit(workspace),
      "--worktree",
      `${workspace.root}/operative`,
    ]);
    expect(readable.exitCode).toBe(4);
    expect(readable.stdout).toContain("cannot read");
    expect(readable.stdout).toContain("release");
  });

  test("restores the recorded selection instead of a session override", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-start.error`);

    const resumed = await dispatch(workspace, crew, ["--crew-host", "opencode"]);
    expect(resumed.exitCode).toBe(4);
    expect(resumed.json.reason).toBe("snapshot_drift");

    const restored = await dispatch(workspace, crew);
    expect(restored.exitCode).toBe(6);
    expect(restored.json.data.agentHost).toBe("claude-code");
    expect((await calls(workspace)).some((line) => line.includes("--kind claude"))).toBe(true);
  });
});

describe("replacement", () => {
  test("refuses a replacement while the former writer is live", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);

    const refused = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("writer_live");
  });

  test("replaces a stopped writer only against the inspection that was read", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-live`);
    await Bun.write(`${workspace.root}/operative/partial.txt`, "half-done work\n");

    const inspection = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(inspection.exitCode).toBe(3);
    expect(inspection.json.reason).toBe("inspection_required");
    expect(inspection.json.data.uncommitted).toContain("?? partial.txt");

    const stale = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
      "--inspection",
      "0".repeat(64),
    ]);
    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("inspection_stale");

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
      inspection.json.data.identity,
    ]);
    expect(replaced.exitCode).toBe(0);
    expect(replaced.json.data.previousAttemptId).toBe(crew.attemptId);
    expect(replaced.json.data.attemptId).not.toBe(crew.attemptId);

    const relaunched = await dispatch(workspace, {
      ownerToken: crew.ownerToken,
      attemptId: replaced.json.data.attemptId,
    });
    expect(relaunched.exitCode).toBe(6);
    expect(
      (await calls(workspace)).filter((line) => line.startsWith("worktree create")),
    ).toHaveLength(1);

    const brief = await Bun.file(`${workspace.root}/operative/.operator/local/brief.md`).text();
    expect(brief).toContain(replaced.json.data.attemptId);
  });

  test("refuses a replacement whose recorded snapshot cannot be read", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-live`);

    const inspection = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(inspection.exitCode).toBe(3);
    await damageSnapshot(workspace, crew.attemptId);

    const blocked = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
      "--inspection",
      inspection.json.data.identity,
    ]);
    expect(blocked.exitCode).toBe(4);
    expect(blocked.json.reason).toBe("snapshot_unreadable");
    expect(blocked.json.blockers[0].attemptId).toBe(crew.attemptId);

    // The attempt keeps its place, so nothing started a second writer on the assignment.
    const shown = await runJson(workspace, ["attempt", "show", "--attempt", crew.attemptId]);
    expect(shown.json.data.current).toBe(true);
  });

  test("refuses a replacement while an effect stays unproven", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-prompt.garbage`, "");
    await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-live`);

    const refused = await runJson(workspace, [
      "attempt",
      "replace",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
    ]);
    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("reconciliation_required");
  });
});

describe("stale ownership", () => {
  test("stops a replaced Operator and its Operative from changing an attempt", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);

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
    expect(taken.exitCode).toBe(0);

    const stale = await dispatch(workspace, crew);
    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("ownership_stale");

    const adopted = await dispatch(workspace, {
      ownerToken: taken.json.data.ownerToken,
      attemptId: crew.attemptId,
    });
    expect(adopted.exitCode).toBe(4);
    expect(adopted.json.reason).toBe("attempt_not_current");

    const acknowledged = await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", crew.attemptId],
      `${workspace.root}/operative`,
    );
    expect(acknowledged.exitCode).toBe(4);
    expect(acknowledged.json.reason).toBe("attempt_not_current");
  });
});

describe("operator attempt submit", () => {
  test("hands a fixed result to a separate review instead of accepting it", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");

    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    expect(submitted.exitCode).toBe(6);
    expect(submitted.json.reason).toBe("result_submitted");
    expect(submitted.json.blockers[0].reason).toBe("review_pending");

    const frontier = await runJson(workspace, ["work", "frontier"]);
    const producerEntry = frontier.json.data.blocked.find(
      (one: { assignmentId: string }) => one.assignmentId === producer.assignmentId,
    );
    expect(producerEntry.blockers[0]).toMatchObject({
      reason: "review_pending",
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
    });
    // The producer attempt ended, so the slot it held is free for the reviewer.
    expect(frontier.json.data.active).toEqual([]);
    expect(
      frontier.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([submitted.json.data.reviewAssignmentId]);
  });

  test("refuses an artifact whose content no longer matches its stated identity", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    await Bun.write(`${producer.worktreePath}/${artifact.path}`, "# Changed after the identity\n");

    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("artifact_identity_changed");
  });

  test("refuses an artifact that is not in the worktree", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, { artifactPath: "docs/absent.md" }),
    );

    expect(submitted.exitCode).toBe(3);
    expect(submitted.json.reason).toBe("artifact_unreadable");
  });

  test("refuses a submission that states requirements the assignment does not hold", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, {
        requirementsIdentity: ContentIdentity.of(["Something else."]),
      }),
    );

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("requirements_changed");
  });

  test("refuses a submission that states a stale assignment revision", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, base, { assignmentRevision: 1 }),
    );

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("stale_revision");
  });

  test("a repeated submission reports the recorded one and creates no second review", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const body = submissionBody(producer, artifact, base);

    const first = await submit(workspace, producer, body);
    const second = await submit(workspace, producer, body);

    expect(second.exitCode).toBe(0);
    expect(second.json.reason).toBe("result_already_submitted");
    expect(second.json.data.submissionId).toBe(first.json.data.submissionId);

    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(
      frontier.json.data.dispatchable.filter((one: { kind: string }) => one.kind === "review")
        .length,
    ).toBe(1);
  });
});

describe("operator attempt dispatch for a review", () => {
  test("a review starts from the submitted commit, never a later one", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      submitted.json.data.reviewAssignmentId,
      "--revision",
      "1",
    ]);
    const drifted = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      claimed.json.data.attemptId,
      "--commit",
      base,
      "--worktree",
      `${workspace.root}/reviewer`,
    ]);

    expect(drifted.exitCode).toBe(4);
    expect(drifted.json.reason).toBe("review_base_changed");
    expect(drifted.json.blockers[0]).toMatchObject({ recorded: artifact.commit, requested: base });
  });

  test("a checkout with no review skill blocks the reviewer before it starts", async () => {
    const workspace = await makeReviewingWorkspace({ reviewSkill: false });
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));

    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      submitted.json.data.reviewAssignmentId,
      "--revision",
      "1",
    ]);
    const dispatched = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      claimed.json.data.attemptId,
      "--commit",
      artifact.commit,
      "--worktree",
      `${workspace.root}/reviewer`,
    ]);

    expect(dispatched.exitCode).toBe(1);
    expect(dispatched.json.reason).toBe("dispatch_stage_failed");
    expect(dispatched.json.blockers[0]).toMatchObject({ stage: "input_preparation" });
    expect(dispatched.json.blockers[0].detail).toContain("code-review");
    // The reviewer host never started, so no partial review exists to reconcile.
    const starts = (await herdrCalls(workspace)).filter((line) => line.startsWith("agent start "));
    expect(starts).toHaveLength(1);
  });
});

describe("operator attempt replace for a review", () => {
  test("a replacement reviewer reopens a blocked review, and the attempts are bounded", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewId = submitted.json.data.reviewId;
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    // The writer must be proven stopped and its partial work inspected before a replacement.
    const replaced = await blockThenReplace(workspace, producer, {
      reviewId,
      submissionIdentity: submitted.json.data.identity,
      attemptId: reviewer.attemptId,
      worktreePath: reviewer.worktreePath,
    });
    expect(replaced.exitCode).toBe(0);

    const reopened = await runJson(workspace, ["review", "show", "--review", reviewId]);
    expect(reopened.json.data.review.state).toBe("registered");
    expect(reopened.json.data.review.blocker).toBeNull();

    // The replacement reviewer reads the same fixed submission and reports it itself.
    const second = { worktreePath: reviewer.worktreePath };
    await relaunchReviewer(workspace, producer, replaced.json.data.attemptId, second.worktreePath);
    const reported = await reportReview(
      workspace,
      second,
      reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );
    expect(reported.json.reason).toBe("review_reported");
    expect(reported.exitCode).toBe(0);
  });

  /** Runs one review until it has used every attempt it holds, and returns that refusal. */
  async function reviewToItsLimit(
    workspace: Awaited<ReturnType<typeof makeReviewingWorkspace>>,
    producer: Awaited<ReturnType<typeof startProducer>>,
    submitted: { data: { reviewId: string; identity: string } },
    reviewer: { attemptId: string; worktreePath: string },
  ) {
    const shared = {
      reviewId: submitted.data.reviewId,
      submissionIdentity: submitted.data.identity,
      worktreePath: reviewer.worktreePath,
    };

    let attemptId = reviewer.attemptId;
    for (const round of [1, 2]) {
      const replaced = await blockThenReplace(workspace, producer, { ...shared, attemptId });
      expect(replaced.json.reason, `round ${round}`).toBe("attempt_replaced");
      attemptId = replaced.json.data.attemptId;
      await relaunchReviewer(workspace, producer, attemptId, reviewer.worktreePath);
    }

    return {
      shared,
      attemptId,
      refused: await blockThenReplace(workspace, producer, { ...shared, attemptId }),
    };
  }

  test("a failing review host escalates instead of taking the crew", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const reviewId = submitted.json.data.reviewId;
    const first = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const { shared, attemptId, refused } = await reviewToItsLimit(
      workspace,
      producer,
      submitted.json,
      first,
    );
    expect(refused.json.reason).toBe("review_attempt_limit");
    expect(refused.exitCode).toBe(3);
    expect(refused.json.blockers[0]).toMatchObject({ reviewId, limit: 3 });
    // The reached limit is recorded as the direction it needs from the user.
    expect(refused.json.data.direction).toMatchObject({
      limitKind: "review_attempts",
      limitValue: 3,
      state: "open",
    });

    // The limit is not a pass, so the result is still unaccepted.
    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(accepted.json.reason).toBe("direction_required");
    expect(accepted.exitCode).toBe(3);

    // The user directs one more reviewer, and the replacement runs only then.
    await grantDirection(
      workspace,
      producer,
      refused.json.data.direction,
      "Try the other host once, then bring it back to me.",
    );
    const directed = await blockThenReplace(workspace, producer, { ...shared, attemptId });
    expect(directed.json.reason).toBe("attempt_replaced");

    // The direction is spent, so acceptance reports the review again instead of the limit.
    const waiting = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
      prHead: artifact.commit,
    });
    expect(waiting.json.reason).toBe("review_incomplete");
  });

  test("a second review that reaches the same limit keeps the first one on the record", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const base = await headCommit(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
    const first = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const limited = await reviewToItsLimit(workspace, producer, submitted.json, first);
    expect(limited.refused.json.reason).toBe("review_attempt_limit");
    const direction = limited.refused.json.data.direction;
    expect(direction.evidence.attempted).toEqual([`review ${submitted.json.data.reviewId}`]);

    // The user directs the crew past that limit, which spends the request it answered.
    await grantDirection(workspace, producer, direction, "Carry on, and show me the next one.");
    await blockThenReplace(workspace, producer, {
      ...limited.shared,
      attemptId: limited.attemptId,
    });

    // The result is combined and handed over again, so a second review reads the revision.
    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: {
        reason: "integration",
        instruction: "Combine it with the accepted helper while its review is stopped.",
        conflicts: [],
        combines: [{ name: "accepted helper", revision: "rev-helper-1" }],
      },
    });
    expect(delegated.json.reason).toBe("rework_delegated");

    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: artifact.commit,
      worktreePath: `${workspace.root}/combined`,
    });
    const combined = await commitArtifact(workspace, reworked, "# Result\n\nCombined.\n");
    const again = await submit(
      workspace,
      reworked,
      submissionBody(reworked, combined, base, {
        assignmentRevision: reworked.assignmentRevision,
      }),
    );
    const secondReviewer = await startReviewer(workspace, producer, again.json, combined.commit);

    const stopped = await reviewToItsLimit(workspace, producer, again.json, secondReviewer);
    expect(stopped.refused.json.reason).toBe("review_attempt_limit");

    // The request opens again, so the spent approval covers nothing, and both failures stand.
    const reopened = stopped.refused.json.data.direction;
    expect(reopened.directionRequestId).toBe(direction.directionRequestId);
    expect(reopened.revision).toBe(2);
    expect(reopened.evidence.attempted).toEqual([
      `review ${submitted.json.data.reviewId}`,
      `review ${again.json.data.reviewId}`,
    ]);
  }, 120_000);
});
