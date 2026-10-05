import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no directory removal API.
import { rm } from "node:fs/promises";
import { makeReviewWorkspace, type Workspace, writeInput } from "./review-cycle-fixture.ts";
import { registerSource, sourceIdOf, workspaceTarget } from "./source-fixture.ts";
import {
  FIXTURE_GATE,
  headCommit,
  herdrCalls,
  nextActions,
  ownCrew,
  requestId as request,
  runGate,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";

// Each test runs real gate commands in a real Git checkout through several CLI processes.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 120_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const SOURCE = sourceIdOf(15);
const GATE_BRANCH = "operator/gate/fveracoechea-operator-15";

/** A gate of one command. The gate checkout sits beside the fixture root, so `..` is that root. */
function gateOf(...commands: Array<{ name: string; argv: string[]; timeoutSeconds?: number }>) {
  return {
    ...FIXTURE_GATE,
    commands: commands.map((one) => ({ timeoutSeconds: 60, ...one })),
  };
}

/** The `crew next` detail of a base that failed or is flaky at one commit. */
function baseBlocked(state: "failed" | "flaky", commit: string, runIds: string): string {
  return `The integration base of source ${SOURCE} is ${state} at commit ${commit} in gate run ${runIds}, and it is not fixed. Only the user clears it: by a fixed main branch and a new base commit, or by an approval of a fresh series that names the key and each failed run. Read a run with \`operator gate show --run <id>\`.`;
}

/** One production assignment of the source, claimed and not dispatched. */
async function claimFirst(workspace: Workspace) {
  const ownerToken = await ownCrew(workspace);
  const registered = await registerSource(workspaceTarget(workspace), ownerToken, {
    sourceKind: "specification",
    parent: 15,
    items: [
      {
        key: "15.1",
        title: "Build the first result",
        body: "Build the first result.",
        permissions: { writePaths: ["docs/"], allowedCommands: ["bun test"], network: false },
      },
    ],
  });
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    registered.assignments[0]?.assignmentId ?? "",
    "--revision",
    "1",
  ]);
  const commit = await headCommit(workspace);
  return {
    ownerToken,
    attemptId: claimed.json.data.attemptId as string,
    worktreePath: `${workspace.root}/operative`,
    commit,
  };
}

/** Runs the gate on one commit of the fixture source. */
async function gate(
  workspace: Workspace,
  request: { ownerToken: string; commit: string; approvalId?: string },
) {
  return runGate(workspace, { ...request, sourceId: SOURCE });
}

type Claimed = Awaited<ReturnType<typeof claimFirst>>;

async function dispatch(workspace: Workspace, claimed: Claimed, commit = claimed.commit) {
  return runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    claimed.ownerToken,
    "--attempt",
    claimed.attemptId,
    "--commit",
    commit,
    "--worktree",
    claimed.worktreePath,
  ]);
}

async function show(workspace: Workspace, runId: string) {
  return (await runJson(workspace, ["gate", "show", "--run", runId])).json.data;
}

/** Waits for a file the test or the runner writes, as a runner in a pane would be watched. */
async function waitFor(path: string): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(50);
  }
  throw new Error(`${path} never appeared`);
}

async function waitForText(path: string, text: string): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    const file = Bun.file(path);
    if ((await file.exists()) && (await file.text()).includes(text)) return;
    await Bun.sleep(50);
  }
  throw new Error(`${path} never held ${text}`);
}

/**
 * Puts a Git on the fixture path that fails each call whose subcommand and first argument match
 * `pattern`, a shell case pattern. `term` ends it on SIGTERM, as a timeout does, and `exit` ends
 * it with exit 3. Each one writes `stderr` first. Every other call runs the real Git.
 */
async function failGit(
  workspace: Workspace,
  fault: { pattern: string; end: "term" | "exit"; stderr: string },
): Promise<void> {
  await Bun.write(
    `${workspace.bin}/git`,
    [
      "#!/bin/sh",
      // The guard of ADR 0018 and `-C <repo>` come before the subcommand.
      'case "$6 $7" in',
      `  ${fault.pattern})`,
      `    printf '%s' '${fault.stderr}' >&2`,
      fault.end === "term" ? "    kill -TERM $$ ;;" : "    exit 3 ;;",
      "esac",
      `exec ${Bun.which("git")} "$@"`,
      "",
    ].join("\n"),
  );
  await Bun.$`chmod +x ${workspace.bin}/git`.quiet();
}

// The Git failure texts of a gate start and of its runner keep their words (#149).
describe("the Git failures of a gate run", () => {
  for (const [end, stderr, detail] of [
    ["term", "stuck", "git -C ended on SIGTERM with no answer."],
    ["exit", "boom", "boom"],
    ["exit", "", "git refused"],
  ] as const) {
    test(`a tree read that ends with ${end} and stderr "${stderr}" names ${detail}`, async () => {
      const workspace = await makeReviewWorkspace(fixtures);
      const claimed = await claimFirst(workspace);
      await failGit(workspace, { pattern: '"rev-parse "*"^{tree}"', end, stderr });

      const refused = await gate(workspace, claimed);

      expect(refused.json).toMatchObject({
        reason: "gate_commit_unread",
        blockers: [{ commit: claimed.commit, detail }],
      });
    });
  }

  for (const [end, detail] of [
    ["term", () => "git -C ended on SIGTERM with no answer."],
    ["exit", (commit: string) => `git checkout --quiet --detach --force ${commit} exited 3: boom`],
  ] as const) {
    test(`a runner checkout that ends with ${end} stops the run with its Git detail`, async () => {
      const workspace = await makeReviewWorkspace(fixtures);
      const claimed = await claimFirst(workspace);
      await failGit(workspace, { pattern: '"checkout "*', end, stderr: "boom" });

      const ran = await gate(workspace, claimed);

      expect(ran.json.reason).toBe("gate_run_started");
      const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
      const row = sqlite
        .query("select state, detail from gate_runs where id = ?")
        .get(ran.json.data.runId);
      sqlite.close();
      expect(row).toEqual({ state: "stopped", detail: detail(claimed.commit) });
      expect(await Bun.file(`${workspace.herdr}/runner.log`).text()).toContain(
        detail(claimed.commit),
      );
    });
  }
});

describe("the gate on the integration base", () => {
  test("the first code dispatch refuses until the base key passes, and crew next offers run_gate", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const claimed = await claimFirst(workspace);

    const refused = await dispatch(workspace, claimed);
    expect(refused.json).toMatchObject({
      outcome: "missing-condition",
      reason: "gate_pending",
      blockers: [{ commit: claimed.commit, runIds: [] }],
    });
    expect(await Bun.file(`${claimed.worktreePath}/.git`).exists()).toBe(false);
    const waiting = await nextActions(workspace);
    expect(waiting.of("run_gate")).toMatchObject({ attemptId: claimed.attemptId, blocker: null });
    expect(waiting.of("run_gate").detail).toBe(
      `The first code dispatch of source ${SOURCE} fixes its integration base, so the base commit passes the project gate first. Run the gate on the commit you will dispatch from.`,
    );
    expect(waiting.names).not.toContain("dispatch_attempt");

    const ran = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    expect(ran.json).toMatchObject({ outcome: "pending", reason: "gate_run_started" });
    const run = await show(workspace, ran.json.data.runId);
    expect(run).toMatchObject({
      state: "passed",
      commit: claimed.commit,
      subject: { kind: "base" },
      commands: [{ name: "quality", outcome: "passed", exitCode: 0 }],
    });
    // The checkout of the gate is detached at the key, so its branch never moves.
    const branch = await Bun.$`git -C ${run.checkoutPath} branch --show-current`.quiet();
    expect(branch.stdout.toString()).toBe("");
    const gateBranch = await Bun.$`git -C ${workspace.repo} rev-parse ${GATE_BRANCH}`.quiet();
    expect(gateBranch.stdout.toString().trim()).toBe(claimed.commit);

    const ready = await nextActions(workspace);
    expect(ready.of("dispatch_attempt").detail).toContain(claimed.commit);
    expect((await dispatch(workspace, claimed)).json.reason).toBe("acknowledgement_pending");
  });

  test("a failed run blocks and is not fixed, and a pass after it makes the key flaky", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: gateOf({ name: "quality", argv: ["test", "-f", "../flag"] }),
    });
    const claimed = await claimFirst(workspace);

    const failed = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    const failedRun = failed.json.data.runId;
    expect((await show(workspace, failedRun)).state).toBe("failed");

    const refused = await dispatch(workspace, claimed);
    expect(refused.json).toMatchObject({
      outcome: "conflict",
      reason: "gate_failed",
      blockers: [{ commit: claimed.commit, runIds: [failedRun] }],
    });
    expect(await Bun.file(`${claimed.worktreePath}/.git`).exists()).toBe(false);
    const blocked = await nextActions(workspace);
    expect(blocked.of("run_gate")).toMatchObject({ blocker: "gate_failed" });
    expect(blocked.of("run_gate").detail).toBe(baseBlocked("failed", claimed.commit, failedRun));

    await Bun.write(`${workspace.root}/flag`, "");
    const passed = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    expect((await show(workspace, passed.json.data.runId)).state).toBe("passed");

    expect((await dispatch(workspace, claimed)).json).toMatchObject({
      reason: "gate_flaky",
      blockers: [{ runIds: [failedRun] }],
    });
    const flaky = (await nextActions(workspace)).of("run_gate");
    expect(flaky.blocker).toBe("gate_flaky");
    expect(flaky.detail).toBe(baseBlocked("flaky", claimed.commit, failedRun));
  });

  test("a command over its time limit fails as timed-out, and each later command is not-run", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: gateOf(
        { name: "slow", argv: ["sleep", "30"], timeoutSeconds: 1 },
        { name: "after", argv: ["true"] },
      ),
    });
    const claimed = await claimFirst(workspace);

    const ran = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });

    expect(await show(workspace, ran.json.data.runId)).toMatchObject({
      state: "failed",
      commands: [
        { name: "slow", outcome: "failed", reason: "timed-out", exitCode: null },
        { name: "after", outcome: "not-run", reason: null, outputPath: null },
      ],
    });
  });

  test("a stale ignored file in the gate checkout does not reach the next run", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      files: { ".gitignore": "cache/\n" },
      gate: gateOf({
        name: "quality",
        argv: ["sh", "-c", "test ! -e cache/stale && mkdir -p cache && touch cache/stale"],
      }),
    });
    const claimed = await claimFirst(workspace);
    const first = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    const checkout = (await show(workspace, first.json.data.runId)).checkoutPath;
    expect(await Bun.file(`${checkout}/cache/stale`).exists()).toBe(true);

    await Bun.write(`${workspace.repo}/README.md`, "# Fixture, changed\n");
    await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit -qam next`.quiet();
    const next = await headCommit(workspace);
    const second = await gate(workspace, { ownerToken: claimed.ownerToken, commit: next });

    expect(await show(workspace, second.json.data.runId)).toMatchObject({
      state: "passed",
      commit: next,
    });
    expect((await Bun.$`git -C ${checkout} rev-parse HEAD`.quiet()).stdout.toString().trim()).toBe(
      next,
    );
  });

  test("a takeover refuses every later write of the former runner", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: gateOf({
        name: "quality",
        argv: ["sh", "-c", "touch ../started; while [ ! -f ../go ]; do sleep 0.1; done"],
      }),
    });
    const claimed = await claimFirst(workspace);
    await Bun.write(`${workspace.herdr}/pane-run.background`, "");

    const started = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    const runId = started.json.data.runId;
    await waitFor(`${workspace.root}/started`);
    const second = await ownCrew(workspace, { label: "second-session", takeoverFrom: 1 });
    await Bun.write(`${workspace.root}/go`, "");
    await waitForText(`${workspace.herdr}/runner.log`, "may not record");

    expect(await show(workspace, runId)).toMatchObject({
      state: "running",
      finishedAt: null,
      commands: [{ name: "quality", outcome: null }],
    });

    // The pane shows no runner now, so the new owner's run replaces the one with no outcome.
    await rm(`${workspace.herdr}/pane-run.background`);
    const replaced = await gate(workspace, { ownerToken: second, commit: claimed.commit });
    expect(await show(workspace, replaced.json.data.runId)).toMatchObject({
      state: "passed",
      replaces: runId,
    });
    expect((await show(workspace, runId)).state).toBe("stopped");
  });

  test("a run is replaced only after its pane shows that its runner stopped", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const claimed = await claimFirst(workspace);
    await Bun.write(`${workspace.herdr}/pane-run.hold`, "");
    const held = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    const runId = held.json.data.runId;
    await Bun.write(
      `${workspace.herdr}/pane-processes`,
      `200|bun|bun cli.ts gate runner --run ${runId}\n`,
    );

    const refused = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    expect(refused.json).toMatchObject({ reason: "gate_running", blockers: [{ runId }] });

    await rm(`${workspace.herdr}/pane-processes`);
    await rm(`${workspace.herdr}/pane-run.hold`);
    const replaced = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    expect(await show(workspace, replaced.json.data.runId)).toMatchObject({
      state: "passed",
      replaces: runId,
    });
  });

  test("a fresh series needs an approval that names the key and each failed run", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: gateOf({ name: "quality", argv: ["test", "-f", "../flag"] }),
    });
    const claimed = await claimFirst(workspace);
    const first = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });

    const unapproved = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
      approvalId: "no-such-approval",
    });
    expect(unapproved.json.reason).toBe("fresh_series_not_approved");
    const asked = unapproved.json.blockers[0].request;
    expect(asked.targets).toEqual([expect.stringMatching(/^gate-key:/), first.json.data.runId]);

    async function approve(targets: string[]): Promise<string> {
      const granted = await runJson(workspace, [
        "approval",
        "grant",
        "--request",
        request(),
        "--owner-token",
        claimed.ownerToken,
        "--input",
        await writeInput(workspace, {
          ...asked,
          targets,
          exactText: "Start a fresh gate series at this key.",
          grantedBy: "human",
        }),
      ]);
      return granted.json.data.approvalId;
    }

    const once = await approve(asked.targets);
    const failedAgain = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
      approvalId: once,
    });
    expect(await show(workspace, failedAgain.json.data.runId)).toMatchObject({
      state: "failed",
      series: once,
    });

    // The new failure is not answered by the first approval, so it starts nothing.
    await Bun.write(`${workspace.root}/flag`, "");
    const stale = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
      approvalId: once,
    });
    expect(stale.json.reason).toBe("fresh_series_not_approved");

    const twice = await approve([...asked.targets, failedAgain.json.data.runId]);
    const passed = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
      approvalId: twice,
    });
    expect((await show(workspace, passed.json.data.runId)).state).toBe("passed");
    // Both failed runs stay recorded, and the fresh series with no failure passes the key.
    expect((await show(workspace, first.json.data.runId)).state).toBe("failed");
    expect((await dispatch(workspace, claimed)).json.reason).toBe("acknowledgement_pending");
  });

  test("an outcome comes from the process, never from pane text", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: gateOf({ name: "quality", argv: ["sh", "-c", "echo quality: passed; exit 3"] }),
    });
    const claimed = await claimFirst(workspace);

    const ran = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });

    const run = await show(workspace, ran.json.data.runId);
    expect(run.commands[0]).toMatchObject({ outcome: "failed", exitCode: 3 });
    expect(await Bun.file(`${workspace.repo}/${run.commands[0].outputPath}`).text()).toBe(
      "quality: passed\n",
    );
    // The report points to the output, and never prints it, so the Operator reads only a summary.
    const human = await runOperator(workspace, ["gate", "show", "--run", run.runId]);
    expect(human.stdout).toContain(run.commands[0].outputPath);
    expect(human.stdout).not.toContain("quality: passed");
    const calls = await herdrCalls(workspace);
    expect(calls.some((line) => line.startsWith("pane read"))).toBe(false);
    // The typed line names the runner, its run, and the root, and no gate command.
    const typed = calls.find((line) => line.startsWith("pane run")) ?? "";
    expect(typed).toContain(`gate runner --run ${run.runId} --root`);
    expect(typed).not.toContain("echo");
  });

  test("a runner line whose Herdr answer is lost stays uncertain", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const claimed = await claimFirst(workspace);
    // The fake types the line and then exits 1 with a text that is not JSON.
    await Bun.write(`${workspace.herdr}/pane-run.lost`, "");

    const ran = await gate(workspace, { ownerToken: claimed.ownerToken, commit: claimed.commit });

    expect(ran.json).toMatchObject({ outcome: "uncertain", reason: "gate_runner_not_typed" });
  });

  test("a gate branch that already exists is refused before Herdr creates anything", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const claimed = await claimFirst(workspace);
    await Bun.$`git -C ${workspace.repo} branch ${GATE_BRANCH}`.quiet();

    const refused = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });

    expect(refused.json).toMatchObject({
      reason: "gate_branch_exists",
      blockers: [{ branch: GATE_BRANCH }],
    });
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("worktree create"))).toBe(
      false,
    );
  });

  test("a new gate checkout at another commit is refused, and no run is recorded or typed", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const claimed = await claimFirst(workspace);
    await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit -q --allow-empty -m "Another commit"`.quiet();
    const other = await headCommit(workspace);
    // The fake Herdr makes the checkout at this commit, not at the base the CLI names.
    await Bun.write(`${workspace.herdr}/gate-checkout-base`, other);

    const refused = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });

    expect(refused.json).toMatchObject({
      reason: "gate_checkout_unplanned",
      blockers: [{ branch: GATE_BRANCH, planned: claimed.commit, found: other }],
    });
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    const runs = sqlite.query("select count(*) as count from gate_runs").get();
    sqlite.close();
    expect(runs).toEqual({ count: 0 });
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("pane run"))).toBe(false);
  });
});

// A named departure of #162: before, `gate show` printed a recorded state outside the four names
// as text. Now it fails loudly. Only a damaged state file gets here.
test("a gate run state that this release cannot read stops gate show loudly", async () => {
  const workspace = await makeReviewWorkspace(fixtures);
  const claimed = await claimFirst(workspace);
  const ran = await gate(workspace, { ownerToken: claimed.ownerToken, commit: claimed.commit });
  const { runId } = ran.json.data;
  expect((await show(workspace, runId)).state).toBe("passed");
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
  sqlite.query("update gate_runs set state = 'damaged' where id = ?").run(runId);
  sqlite.close();

  const shown = await runOperator(workspace, ["gate", "show", "--run", runId, "--json"]);
  expect(shown.exitCode).not.toBe(0);
  expect(shown.stdout + shown.stderr).toContain(
    "the crew state holds a gate run state this release cannot read: damaged",
  );
});

describe("the crew next texts of the base gate", () => {
  test("a running base run names its commit, and a stopped one names its detail", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const claimed = await claimFirst(workspace);
    await Bun.write(`${workspace.herdr}/pane-run.hold`, "");
    const held = await gate(workspace, { ownerToken: claimed.ownerToken, commit: claimed.commit });
    const { runId } = held.json.data;

    const running = await nextActions(workspace);
    expect(
      running.waits
        .filter((one) => one.wait === "gate_running" && one.attemptId === claimed.attemptId)
        .map((one) => one.detail),
    ).toEqual([
      `Gate run ${runId} of source ${SOURCE} runs at commit ${claimed.commit}. Its runner wakes the Operator at the end. If its pane shows no runner, \`operator gate run\` replaces it.`,
    ]);

    // The pane shows no runner now, so a new run replaces the held one, and its runner records a
    // stop because it cannot prepare the gate checkout.
    await rm(`${workspace.herdr}/pane-run.hold`);
    await failGit(workspace, { pattern: '"checkout "*', end: "exit", stderr: "boom" });
    const replaced = await gate(workspace, {
      ownerToken: claimed.ownerToken,
      commit: claimed.commit,
    });
    expect(replaced.json.reason).toBe("gate_run_started");
    const stoppedRun = replaced.json.data.runId;
    const detail = `git checkout --quiet --detach --force ${claimed.commit} exited 3: boom`;
    expect(await show(workspace, stoppedRun)).toMatchObject({ state: "stopped", detail });

    const stopped = await nextActions(workspace);
    expect(
      stopped
        .forAction("run_gate")
        .filter((one) => one.attemptId === claimed.attemptId)
        .map((one) => one.detail),
    ).toEqual([
      `The first code dispatch of source ${SOURCE} fixes its integration base, so the base commit passes the project gate first. Run the gate on the commit you will dispatch from. Gate run ${stoppedRun} stopped with no outcome: ${detail}.`,
    ]);
  });
});
