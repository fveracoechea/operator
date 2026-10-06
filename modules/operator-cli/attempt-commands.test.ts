import { registerSource, sourceIdOf, workspaceTarget } from "./source-fixture.ts";
import { afterEach, describe, expect, test as bunTest } from "bun:test";
// Bun has no recursive directory removal, directory creation, or chmod API.
import { chmod, mkdir, rm } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import {
  passBaseGate,
  runGate,
  headCommit,
  herdrCalls,
  markFakeAgent,
  requestId as request,
  runJson,
  runOperator,
  stopFakeAgents,
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
  moveRecordedTip,
  relaunchReviewer,
  reportBody,
  reportReview,
  startProducer,
  startRework,
  startReviewer,
  submissionBody,
  submit,
} from "./review-cycle-fixture.ts";

// Dispatch tests create Git worktrees and run several CLI processes under the parallel CI gate.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

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

type FixedInput = { name: string; kind: string; value: string; contentIdentity: string | null };

async function claimedAttempt(
  workspace: Workspace,
  fixedInputs: FixedInput[] = [
    { name: "brief", kind: "value", value: "the brief", contentIdentity: null },
  ],
) {
  const owned = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    "operator-session",
  ]);
  const ownerToken = owned.json.data.ownerToken;

  const registered = await registerSource(workspaceTarget(workspace), ownerToken, {
    sourceKind: "specification",
    parent: 20,
    items: [
      {
        key: "20.1",
        title: "Dispatch one Operative",
        body: "Build the dispatch path.",
        permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
        fixedInputs,
      },
    ],
  });
  const assignmentId = registered.assignments[0]?.assignmentId ?? "";

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
  // The first code dispatch of the source starts only from a base that passed the project gate.
  await passBaseGate(workspace, {
    ownerToken,
    attemptId: claimed.json.data.attemptId,
    commit: await headCommit(workspace),
  });

  return {
    ownerToken,
    assignmentId,
    attemptId: claimed.json.data.attemptId,
    assignmentRevision: Number(claimed.json.data.revision),
  };
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
  await Bun.$`${process.execPath} -e ${`
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
  test("refuses a JSR base commit whose lock does not pin the selected dependency", async () => {
    const running = await OperatorRelease.identify();
    const lock = await Bun.file(`${running.installationRoot}/${running.lock.name}`).text();
    const workspace = await fixtures.make({
      files: {
        "bun.lock": lock,
        "package.json": JSON.stringify({
          scripts: { operator: "bun node_modules/@fveracoechea/operator/cli.js" },
          devDependencies: {
            "@fveracoechea/operator": `npm:@jsr/fveracoechea__operator@${running.version}`,
          },
        }),
      },
    });
    await ReleaseInstall.select({
      projectRoot: workspace.repo,
      selection: {
        schemaVersion: 1,
        delivery: "jsr",
        version: running.version,
        commit: "f".repeat(40),
        releaseIdentity: running.identity,
        skillsIdentity: running.skillsIdentity,
        packageVersion: running.version,
        upstreamSkills: [],
        selectedAt: new Date().toISOString(),
      },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);

    expect(dispatched.json.reason).toBe("dispatch_stage_failed");
    expect(JSON.stringify(dispatched.json)).toContain("bun.lock");
    expect((await calls(workspace)).some((call) => call.startsWith("agent start"))).toBe(false);
  });

  test("uses the pinned source command in a selected source Operative brief", async () => {
    const workspace = await makeWorkspace();
    const commit = "f".repeat(40);
    const release = await OperatorRelease.identify();
    await ReleaseInstall.select({
      projectRoot: workspace.repo,
      selection: {
        schemaVersion: 1,
        delivery: "github-source",
        version: release.version,
        commit,
        releaseIdentity: release.identity,
        skillsIdentity: release.skillsIdentity,
        packageVersion: null,
        upstreamSkills: [],
        selectedAt: new Date().toISOString(),
      },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);

    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    const brief = await Bun.file(`${workspace.root}/operative/.operator/local/brief.md`).text();
    const prompt = await Bun.file(`${workspace.herdr}/last-prompt`).text();
    const source = `bunx "github:fveracoechea/operator#${commit}"`;
    expect(brief).toContain(`${source} attempt acknowledge --request`);
    expect(prompt).toContain(`${source} attempt acknowledge --request`);
    expect(prompt).not.toContain("bun install --frozen-lockfile");
  });

  test("blocks a JSR worktree whose base commit predates its devDependency", async () => {
    const workspace = await makeWorkspace();
    const base = await headCommit(workspace);
    const release = await OperatorRelease.identify();
    await ReleaseInstall.select({
      projectRoot: workspace.repo,
      selection: {
        schemaVersion: 1,
        delivery: "jsr",
        version: release.version,
        commit: "f".repeat(40),
        releaseIdentity: release.identity,
        skillsIdentity: release.skillsIdentity,
        packageVersion: release.version,
        upstreamSkills: [],
        selectedAt: new Date().toISOString(),
      },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      crew.ownerToken,
      "--attempt",
      crew.attemptId,
      "--commit",
      base,
      "--worktree",
      `${workspace.root}/operative`,
    ]);

    expect(dispatched.json.reason).toBe("dispatch_stage_failed");
    expect(JSON.stringify(dispatched.json)).toContain("package.json");
    expect((await calls(workspace)).some((call) => call.startsWith("agent start"))).toBe(false);
  });

  test("healthcheck reports unproven readiness as a standing precondition, not a dispatch gate", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    const health = await runJson(workspace, ["healthcheck", "--claude"]);
    expect(health.json.data.readiness.state).not.toBe("ready");

    const launched = await dispatch(workspace, crew);
    expect(launched.json.reason).toBe("acknowledgement_pending");
    expect(health.json.data.dispatch).toEqual({
      readinessRequired: false,
      gate: "assignment-and-launch-preconditions",
    });
    const human = await runOperator(workspace, ["healthcheck", "--claude"]);
    expect(human.stdout).toContain("Readiness is a standing precondition");
    expect(human.stdout).not.toContain("must be proven before a new attempt can dispatch");
  });

  test("groups an Operative worktree with the Operator's current Herdr workspace", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);

    const dispatched = await runJson(
      workspace,
      [
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
      ],
      workspace.repo,
      { HERDR_WORKSPACE_ID: "stale", HERDR_PANE_ID: "w0:p1" },
    );

    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    const created = (await calls(workspace)).find((line) => line.startsWith("worktree create"));
    expect(created).toContain("--workspace w0");
    expect(created).not.toContain("--cwd");
  });

  test("refuses a new launch outside a Herdr workspace", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    const launched = await runJson(
      workspace,
      [
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
      ],
      workspace.repo,
      { HERDR_WORKSPACE_ID: "", HERDR_PANE_ID: "" },
    );

    expect(launched.json.reason).toBe("herdr_workspace_required");
    expect((await calls(workspace)).some((line) => line.startsWith("worktree create"))).toBe(false);
  });

  test("keeps the original parent workspace when retrying a failed worktree creation", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/worktree-create.error`, "worktree_refused");

    const failed = await dispatch(workspace, crew);
    expect(failed.json.reason).toBe("dispatch_stage_failed");
    await rm(`${workspace.herdr}/worktree-create.error`);

    const retried = await runJson(
      workspace,
      [
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
      ],
      workspace.repo,
      { HERDR_WORKSPACE_ID: "w9", HERDR_PANE_ID: "w9:p1" },
    );

    expect(retried.json.reason).toBe("acknowledgement_pending");
    expect((await calls(workspace)).filter((line) => line.startsWith("worktree create"))).toEqual([
      expect.stringContaining("--workspace w0"),
      expect.stringContaining("--workspace w0"),
    ]);
  });

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
    // The worktree carries the release identity, the delivery identity, and the lock data the
    // launch fixed, so coordinated work runs what the project selected.
    const released = await Bun.file(`${worktree}/.operator/local/release.json`).json();
    expect(Object.keys(released).toSorted()).toEqual([
      "identity",
      "installation",
      "lock",
      "skills",
      "version",
    ]);
    expect(Object.keys(released.installation).toSorted()).toEqual([
      "commit",
      "delivery",
      "packageVersion",
    ]);
    expect(await Bun.file(`${worktree}/.operator/local/bun.lock`).exists()).toBe(true);
    expect(await Bun.file(`${worktree}/.claude/skills/operator/SKILL.md`).exists()).toBe(true);
    expect(await Bun.file(`${worktree}/.claude/skills/operative/SKILL.md`).exists()).toBe(true);

    const brief = await Bun.file(`${worktree}/.operator/local/brief.md`).text();
    expect(brief).toContain(crew.attemptId);
    expect(brief).toContain(crew.assignmentId);
    expect(brief).toContain("Build the dispatch path.");
    expect(brief).toContain("The quality gate passes.");
    expect(brief).toContain(`- Assignment revision: ${crew.assignmentRevision}`);
    expect(brief).toContain(
      `- Requirements identity: ${ContentIdentity.of(["The quality gate passes."])}`,
    );
    expect(brief).toContain("modules/");
    expect(brief).toContain("operator attempt acknowledge");

    const reference = await Bun.file(`${worktree}/.operator/local/attempt.json`).json();
    expect(reference.controllingCheckout).toBe(workspace.repo);
    expect(reference.attemptId).toBe(crew.attemptId);

    const prompt = await Bun.file(`${workspace.herdr}/last-prompt`).text();
    expect(prompt).toContain(crew.attemptId);
    expect(prompt).toContain(".operator/local/brief.md");
    expect(prompt).toContain("Load the `operative` skill");

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

  test("keeps a live writer and its pane when Herdr refuses its display label", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/pane-report-metadata.error`, "label_refused");

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect(
      dispatched.json.data.operations.find((one: { kind: string }) => one.kind === "agent_start"),
    ).toMatchObject({ state: "succeeded", detail: expect.stringContaining("label_refused") });
    expect((await calls(workspace)).some((one) => one.startsWith("agent prompt "))).toBe(true);

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
    expect(refused.json.reason).toBe("writer_live");
    expect(refused.json.blockers[0].paneId).toBe("w1:p1");

    await dispatch(workspace, crew);
    expect((await calls(workspace)).filter((one) => one.startsWith("agent start "))).toHaveLength(
      1,
    );
  });

  test("keeps the start result when a display label has no answer", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/pane-report-metadata.lost`, "");

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect(
      dispatched.json.data.operations.find((one: { kind: string }) => one.kind === "agent_start"),
    ).toMatchObject({
      state: "succeeded",
      detail: expect.stringContaining("Display label unconfirmed"),
    });
    expect((await calls(workspace)).some((one) => one.startsWith("agent prompt "))).toBe(true);
  });

  test("starts the selected OpenCode crew model rather than the host default", async () => {
    const workspace = await makeWorkspace({
      crew: { host: "opencode", model: "openai/gpt-5.6-terra" },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);

    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect((await calls(workspace)).find((line) => line.startsWith("agent start"))).toContain(
      "-- --model openai/gpt-5.6-terra",
    );
  });

  test("applies OpenCode effort through a worktree-local agent and records it", async () => {
    const workspace = await makeWorkspace({
      crew: { host: "opencode", model: "openai/gpt-6-sol", reasoningEffort: "medium" },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect((await calls(workspace)).find((line) => line.startsWith("agent start"))).toContain(
      "-- --model openai/gpt-6-sol --agent operator-crew",
    );
    const agent = await Bun.file(
      `${workspace.root}/operative/.opencode/agents/operator-crew.md`,
    ).text();
    expect(agent).toContain("reasoningEffort: medium");
    expect(agent).toContain("variant: medium");
    const pluginPath = `${workspace.root}/operative/.opencode/plugins/operator-crew-effort.ts`;
    const plugin = await Bun.file(pluginPath).text();
    expect(plugin).toContain('output.options.reasoningEffort = "medium"');
    const hooks = await (await import(pluginPath)).default();
    const selected = { options: { reasoningEffort: "high" } };
    await hooks["chat.params"]({ agent: "operator-crew" }, selected);
    expect(selected.options.reasoningEffort).toBe("medium");
    const other = { options: { reasoningEffort: "high" } };
    await hooks["chat.params"]({ agent: "build" }, other);
    expect(other.options.reasoningEffort).toBe("high");
    const brief = await Bun.file(`${workspace.root}/operative/.operator/local/brief.md`).text();
    expect(brief).toContain("- Crew reasoning effort: medium");
    const shown = await runJson(workspace, ["attempt", "show", "--attempt", crew.attemptId]);
    expect(shown.json.data.reasoningEffort).toBe("medium");
  });

  test("passes Claude Code effort as a session flag", async () => {
    const workspace = await makeWorkspace({
      crew: { host: "claude-code", reasoningEffort: "high" },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect((await calls(workspace)).find((line) => line.startsWith("agent start"))).toContain(
      "-- --effort high",
    );
  });

  // A permission prompt waits for the person, and an Operative never addresses the person.
  test("starts a Claude Code Operative that never asks and may run what its brief names", async () => {
    const workspace = await makeWorkspace({
      crew: { host: "claude-code", model: "claude-sonnet-5", reasoningEffort: "high" },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    const start = (await calls(workspace)).find((line) => line.startsWith("agent start")) ?? "";
    // The line names the settings file and never carries the allow list, so it stays short (#196).
    const settingsPath = `${workspace.root}/operative/.operator/local/claude-settings.json`;
    expect(start.trim()).toEndWith(
      `--kind claude --pane w1:p1 -- --model claude-sonnet-5 --effort high --permission-mode dontAsk --settings ${settingsPath}`,
    );

    const settings = await Bun.file(settingsPath).json();
    const allowed: string[] = settings.permissions.allow;
    const brief = await Bun.file(`${workspace.root}/operative/.operator/local/brief.md`).text();
    const commands = [...brief.matchAll(/^(.+? (?:attempt|question|review) [a-z]+) --/gm)].map(
      (match) => match[1],
    );
    expect(commands).toContain("operator attempt acknowledge");
    expect(commands).toContain("operator attempt submit");
    expect(commands).toContain("operator question raise");
    for (const command of commands) expect(allowed).toContain(`Bash(${command}:*)`);
    expect(allowed).toContain("Bash(bun test:*)");
    expect(allowed).toContain("Edit(./modules/**)");
    expect(brief).toContain("under `.operator/local/outbox/`");
    expect(allowed).toContain("Edit(./.operator/local/outbox/**)");
    expect(allowed).not.toContain("WebFetch");
  });

  test("gives an OpenCode Operative no Claude Code permission mode", async () => {
    const workspace = await makeWorkspace({
      crew: { host: "opencode", model: "openai/gpt-5.6-terra" },
    });
    const crew = await claimedAttempt(workspace);

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    expect((await calls(workspace)).find((line) => line.startsWith("agent start"))).not.toContain(
      "--permission-mode",
    );
    expect(
      await Bun.file(`${workspace.root}/operative/.operator/local/claude-settings.json`).exists(),
    ).toBe(false);
  });

  test("refuses OpenCode effort without an explicit supported model before creating a worktree", async () => {
    const workspace = await makeWorkspace({
      crew: { host: "opencode", reasoningEffort: "medium" },
    });
    const crew = await claimedAttempt(workspace);

    const result = await dispatch(workspace, crew);
    expect(result.json.reason).toBe("reasoning_effort_unsupported");
    expect(result.json.blockers[0].detail).toContain("explicit OpenAI crew model");
    expect((await calls(workspace)).some((line) => line.startsWith("worktree create"))).toBe(false);
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
      "pane get",
      "pane list",
      "pane report-metadata",
      "tab list",
      "tab rename",
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

  test("blocks a launch whose path fixed input changed at the base commit", async () => {
    const workspace = await fixtures.make({
      config: { crew: { host: "claude-code" } },
      files: { "docs/spec.md": "# Spec\n" },
    });
    const crew = await claimedAttempt(workspace, [
      {
        name: "spec",
        kind: "path",
        value: "docs/spec.md",
        contentIdentity: ContentIdentity.ofText("# Spec\n"),
      },
    ]);
    await Bun.write(`${workspace.repo}/docs/spec.md`, "# Changed spec\n");
    await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit -qam change`.quiet();
    // The new base commit has its own key, so it passes the gate before it is dispatched.
    await runGate(workspace, {
      ownerToken: crew.ownerToken,
      commit: await headCommit(workspace),
      sourceId: sourceIdOf(20),
    });

    const failed = await dispatch(workspace, crew);
    expect(failed.exitCode).toBe(1);
    expect(failed.json.reason).toBe("dispatch_stage_failed");
    expect(failed.json.blockers[0].stage).toBe("input_preparation");
    expect(failed.json.blockers[0].detail).toContain("docs/spec.md");
    expect((await calls(workspace)).some((line) => line.startsWith("agent start"))).toBe(false);
    // The launch repairs nothing and tears nothing down: the worktree and its branch stay.
    expect(await Bun.file(`${workspace.root}/operative/docs/spec.md`).text()).toBe(
      "# Changed spec\n",
    );
    const branches = await Bun.$`git -C ${workspace.repo} branch --list ${"operator/*"}`.text();
    expect(branches.trim()).not.toBe("");
  });

  test("blocks a launch whose path fixed input is not committed at the base commit", async () => {
    const workspace = await makeWorkspace();
    await Bun.write(`${workspace.repo}/docs/spec.md`, "# Spec\n");
    const crew = await claimedAttempt(workspace, [
      {
        name: "spec",
        kind: "path",
        value: "docs/spec.md",
        contentIdentity: ContentIdentity.ofText("# Spec\n"),
      },
    ]);

    const failed = await dispatch(workspace, crew);
    expect(failed.exitCode).toBe(1);
    expect(failed.json.blockers[0].stage).toBe("input_preparation");
    expect(failed.json.blockers[0].detail).toContain("docs/spec.md");
    expect((await calls(workspace)).some((line) => line.startsWith("agent start"))).toBe(false);
  });

  test("launches with a path fixed input that matches its identity at the base commit", async () => {
    const workspace = await fixtures.make({
      config: { crew: { host: "claude-code" } },
      files: { "docs/spec.md": "# Spec\n" },
    });
    const identity = ContentIdentity.ofText("# Spec\n");
    const crew = await claimedAttempt(workspace, [
      { name: "spec", kind: "path", value: "docs/spec.md", contentIdentity: identity },
    ]);

    const dispatched = await dispatch(workspace, crew);
    expect(dispatched.json.reason).toBe("acknowledgement_pending");
    const brief = await Bun.file(`${workspace.root}/operative/.operator/local/brief.md`).text();
    expect(brief).toContain(`- spec (path): docs/spec.md [${identity}]`);
    expect(brief).toContain("These inputs are fixed at registration.");
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
    const uncertain = await dispatch(workspace, crew);
    await rm(`${workspace.herdr}/agent-start.garbage`);
    // The fake records a live agent, so the unanswered start did reach Herdr.
    await markFakeAgent(workspace, uncertain.json.data.agentName);

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
    await stopFakeAgents(workspace);

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

  // A reference that is there but unusable is a different case from a command that runs in the
  // wrong directory, so its reason and its message must not send the Operative elsewhere.
  test("refuses a missing, malformed, or mismatched reference in the worktree by name", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);
    const operative = `${workspace.root}/operative`;
    const path = `${operative}/.operator/local/attempt.json`;
    const written = await Bun.file(path).text();
    const acknowledgeAs = (attemptId: string) =>
      runJson(
        workspace,
        ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
        operative,
      );
    const humanAcknowledge = () =>
      runOperator(
        workspace,
        ["attempt", "acknowledge", "--request", request(), "--attempt", crew.attemptId],
        operative,
      );

    await rm(path);
    const missing = await acknowledgeAs(crew.attemptId);
    expect(missing.exitCode).toBe(3);
    expect(missing.json.reason).toBe("attempt_reference_missing");

    const { attemptId: _, ...withoutAttempt } = JSON.parse(written);
    const write = (text: string) => async () => {
      await Bun.write(path, text);
    };
    // Anything at the path that is not a readable file is malformed, never missing.
    const malformed = [
      { at: "directory", place: () => mkdir(path), problem: "unreadable", fields: [] },
      {
        at: "unreadable file",
        place: async () => {
          await Bun.write(path, written);
          await chmod(path, 0o000);
        },
        problem: "unreadable",
        fields: [],
      },
      { at: "not JSON", place: write("{ not json"), problem: "not-json", fields: [] },
      { at: "array", place: write("[]\n"), problem: "not-object", fields: [] },
      {
        at: "incomplete",
        place: write(JSON.stringify({ ...withoutAttempt, branch: "" })),
        problem: "incomplete",
        fields: ["attemptId", "branch"],
      },
    ];
    for (const one of malformed) {
      await rm(path, { recursive: true, force: true });
      await one.place();
      const refused = await acknowledgeAs(crew.attemptId);
      expect({ at: one.at, exitCode: refused.exitCode, json: refused.json }).toEqual({
        at: one.at,
        exitCode: 2,
        json: {
          schemaVersion: 1,
          outcome: "invalid",
          reason: "attempt_reference_malformed",
          blockers: [
            {
              reason: "attempt_reference_malformed",
              attemptId: crew.attemptId,
              problem: one.problem,
              fields: one.fields,
            },
          ],
          operation: "attempt_acknowledge",
        },
      });
      const human = await humanAcknowledge();
      expect({ at: one.at, exitCode: human.exitCode }).toEqual({ at: one.at, exitCode: 2 });
      for (const field of one.fields) expect(human.stdout).toContain(field);
      expect(human.stdout).not.toContain("carries no");
    }

    const other = crypto.randomUUID();
    await Bun.write(path, JSON.stringify({ ...JSON.parse(written), attemptId: other }));
    const changed = await acknowledgeAs(crew.attemptId);
    expect(changed.exitCode).toBe(4);
    expect(changed.json.blockers).toEqual([
      { reason: "attempt_reference_mismatch", attemptId: crew.attemptId, recordedAttemptId: other },
    ]);

    await Bun.write(path, written);
    const named = await acknowledgeAs(other);
    expect(named.exitCode).toBe(4);
    expect(named.json.reason).toBe("attempt_reference_mismatch");

    // No refusal recorded anything, so the restored reference acknowledges.
    expect((await acknowledgeAs(crew.attemptId)).json.reason).toBe("attempt_acknowledged");
  });

  // The reference file names the project root, so its absence comes first. The mismatch comes
  // before the request input and before every refusal that the crew state gives.
  test("refuses in the order: missing reference, mismatch, input, crew state", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);
    const other = crypto.randomUUID();
    const operative = `${workspace.root}/operative`;
    const unreadable = `${workspace.root}/absent-input.json`;
    const submitAs = (attemptId: string, cwd: string) =>
      runJson(
        workspace,
        [
          "attempt",
          "submit",
          "--request",
          request(),
          "--attempt",
          attemptId,
          "--input",
          unreadable,
        ],
        cwd,
      );

    const missing = await submitAs(other, workspace.repo);
    expect(missing.exitCode).toBe(3);
    expect(missing.json.reason).toBe("attempt_reference_missing");
    expect(missing.json.blockers).toEqual([
      { reason: "attempt_reference_missing", attemptId: other },
    ]);

    const mismatch = await submitAs(other, operative);
    expect(mismatch.exitCode).toBe(4);
    expect(mismatch.stdout).toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        outcome: "conflict",
        reason: "attempt_reference_mismatch",
        blockers: [
          {
            reason: "attempt_reference_mismatch",
            attemptId: other,
            recordedAttemptId: crew.attemptId,
          },
        ],
        operation: "attempt_submit",
      })}\n`,
    );
    const human = await runOperator(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", other],
      operative,
    );
    expect(human.stdout).toBe(`This worktree belongs to attempt ${crew.attemptId}.\n`);

    const input = await submitAs(crew.attemptId, operative);
    expect(input.json.reason).toBe("invalid_submission_input");
  });
});

describe("snapshot restoration", () => {
  test("reports a changed reasoning effort before resuming a failed launch", async () => {
    const workspace = await makeWorkspace({
      crew: { host: "claude-code", reasoningEffort: "low" },
    });
    const crew = await claimedAttempt(workspace);
    await Bun.write(`${workspace.herdr}/agent-start.error`, "agent_not_ready");
    await dispatch(workspace, crew);
    await Bun.write(
      `${workspace.repo}/.operator/config.json`,
      `${JSON.stringify({ crew: { host: "claude-code", reasoningEffort: "high" } })}\n`,
    );
    await rm(`${workspace.herdr}/agent-start.error`);

    const resumed = await dispatch(workspace, crew);
    expect(resumed.json.reason).toBe("snapshot_drift");
    expect(resumed.json.blockers.map((one: { input: string }) => one.input)).toContain(
      "selection.crew.reasoningEffort",
    );
  });
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
    await stopFakeAgents(workspace);
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

  test("relaunches a replacement whose former writer changed a path fixed input", async () => {
    const workspace = await fixtures.make({
      config: { crew: { host: "claude-code" } },
      files: { "docs/spec.md": "# Spec\n" },
    });
    const crew = await claimedAttempt(workspace, [
      {
        name: "spec",
        kind: "path",
        value: "docs/spec.md",
        contentIdentity: ContentIdentity.ofText("# Spec\n"),
      },
    ]);
    await dispatch(workspace, crew);
    await stopFakeAgents(workspace);
    // The former writer edited and committed the input inside the kept worktree, as partial work can.
    await Bun.write(`${workspace.root}/operative/docs/spec.md`, "# Edited spec\n");
    await Bun.$`git -C ${workspace.root}/operative -c user.email=t@example.com -c user.name=Test commit -qam partial`.quiet();

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

    const relaunched = await dispatch(workspace, {
      ownerToken: crew.ownerToken,
      attemptId: replaced.json.data.attemptId,
    });
    expect(relaunched.json.reason).toBe("acknowledgement_pending");
    // The partial work stays in the kept worktree.
    expect(await Bun.file(`${workspace.root}/operative/docs/spec.md`).text()).toBe(
      "# Edited spec\n",
    );
  });

  test("refuses a replacement whose recorded snapshot cannot be read", async () => {
    const workspace = await makeWorkspace();
    const crew = await claimedAttempt(workspace);
    await dispatch(workspace, crew);
    await stopFakeAgents(workspace);

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
    await stopFakeAgents(workspace);

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
    const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");

    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));

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
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        artifactIdentity: ContentIdentity.ofText("# Changed after the identity\n"),
      }),
    );

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("artifact_identity_changed");
  });

  test("refuses an artifact that is not in the worktree", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, { artifactPath: "docs/absent.md" }),
    );

    expect(submitted.exitCode).toBe(3);
    expect(submitted.json.reason).toBe("artifact_unreadable");
  });

  test("refuses a submission that states requirements the assignment does not hold", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        requirementsIdentity: ContentIdentity.of(["Something else."]),
      }),
    );

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("requirements_changed");
  });

  test("refuses a submission that states a stale assignment revision", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, { assignmentRevision: 1 }),
    );

    expect(submitted.exitCode).toBe(4);
    expect(submitted.json.reason).toBe("stale_revision");
  });

  test("a repeated submission reports the recorded one and creates no second review", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const body = submissionBody(producer, artifact);

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
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));

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
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));

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

// This repository tracks its bundled skills, and each host directory links to them, so a result
// can change a skill that the next launch installs.
const OPERATIVE_SKILL = new URL("../../skills/operative/SKILL.md", import.meta.url).pathname;

async function makeSkillTrackingWorkspace(operative: string) {
  const workspace = await makeReviewWorkspace(fixtures, {
    files: { "skills/operative/SKILL.md": operative },
  });
  await Bun.$`mkdir -p ${workspace.repo}/.agents/skills`.quiet();
  await Bun.$`ln -s ../../skills/operative ${workspace.repo}/.agents/skills/operative`.quiet();
  await Bun.$`ln -s ../../.agents/skills/operative ${workspace.repo}/.claude/skills/operative`.quiet();
  await Bun.$`git -C ${workspace.repo} add -A`.quiet();
  await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit -qm skills`.quiet();
  return workspace;
}

describe("operator attempt dispatch of a tracked skill copy", () => {
  test("keeps a skill copy that crew work changed after the integration base", async () => {
    const release = await Bun.file(OPERATIVE_SKILL).text();
    const workspace = await makeSkillTrackingWorkspace(release);
    const producer = await startProducer(workspace, undefined, { writePaths: ["skills/"] });
    const changed = `${release}\nA crew change under review.\n`;
    const artifact = await commitArtifact(
      workspace,
      producer,
      changed,
      "skills/operative/SKILL.md",
    );
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    expect(submitted.json.reason).toBe("result_submitted");

    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    expect(reviewer.dispatched.json.reason).toBe("acknowledgement_pending");
    const copy = `${reviewer.worktreePath}/.claude/skills/operative/SKILL.md`;
    expect(await Bun.file(copy).text()).toBe(changed);
    // The launch record names the copy the reviewer loads in place of the release copy.
    const released = await Bun.file(`${reviewer.worktreePath}/.operator/local/release.json`).json();
    expect(released.skills.committed).toEqual([
      { path: ".claude/skills/operative/SKILL.md", identity: ContentIdentity.ofText(changed) },
    ]);
    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain(
      `- Skill copy changed after the integration base: .claude/skills/operative/SKILL.md (${ContentIdentity.ofText(changed)})`,
    );
  });

  test("refuses a skill copy that already differs at the integration base", async () => {
    const release = await Bun.file(OPERATIVE_SKILL).text();
    const workspace = await makeSkillTrackingWorkspace(`${release}\nA change of the person.\n`);

    const producer = await startProducer(workspace, undefined, {
      writePaths: ["skills/"],
      acknowledge: false,
    });

    expect(producer.dispatched.reason).toBe("dispatch_stage_failed");
    expect(producer.dispatched.blockers[0]).toMatchObject({
      stage: "input_preparation",
      detail:
        "skill_copy_conflict: The worktree holds changed skill copies: .claude/skills/operative/SKILL.md",
    });
    const starts = (await herdrCalls(workspace)).filter((line) => line.startsWith("agent start "));
    expect(starts).toHaveLength(0);
  });
});

describe("operator attempt replace for a review", () => {
  test("a replacement reviewer reopens a blocked review, and the attempts are bounded", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
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
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
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
    });
    expect(waiting.json.reason).toBe("review_incomplete");
  });

  test("a second review that reaches the same limit keeps the first one on the record", async () => {
    const workspace = await makeReviewingWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
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

    // The tip moved under the result, so it is combined and handed over again, and a second
    // review reads the revision.
    await moveRecordedTip(workspace, { path: "docs/result.md", text: "# Other\n" });
    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: { reason: "integration", conflicts: [] },
    });
    expect(delegated.json.reason).toBe("rework_delegated");

    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: null,
      worktreePath: `${workspace.root}/combined`,
    });
    const combined = await commitArtifact(workspace, reworked, "# Result\n\nCombined.\n");
    const again = await submit(
      workspace,
      reworked,
      submissionBody(reworked, combined, {
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
