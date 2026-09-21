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

async function makeWorkspace(config: unknown = { crew: { host: "claude-code" } }) {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-attempt-${crypto.randomUUID()}`;
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

  await Bun.write(`${workspace.repo}/.operator/config.json`, `${JSON.stringify(config)}\n`);
  await Bun.write(`${workspace.repo}/README.md`, "# Fixture\n");
  await Bun.$`git init -b main ${workspace.repo}`.quiet();
  await Bun.$`git -C ${workspace.repo} add -A`.quiet();
  await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit -m first`.quiet();

  // The CLI reports the directory it resolved, so the fixture compares against the same reading.
  workspace.repo = await realpath(workspace.repo);
  return workspace;
}

async function headCommit(workspace: Workspace): Promise<string> {
  return (await Bun.$`git -C ${workspace.repo} rev-parse HEAD`.quiet()).stdout.toString().trim();
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

async function calls(workspace: Workspace): Promise<string[]> {
  const file = Bun.file(`${workspace.herdr}/calls.log`);
  return (await file.exists())
    ? (await file.text()).split("\n").filter((line) => line.length > 0)
    : [];
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

  test("blocks a failed preparation before any agent starts", async () => {
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
