import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FakeIssue, GithubFakeState } from "./github-fake-state.ts";
import {
  githubCalls,
  herdrCalls,
  runJson,
  seedProbePartial,
  seedProbeReports,
  type Workspace,
  workspaces,
} from "./workspace-fixture.ts";

const fixtures = workspaces();

/** One probe run launches agents and writes a tracker fixture, so it outlasts the default limit. */
const PROBE_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await fixtures.removeAll();
});

const FIXTURE_REPOSITORY = "someone/probe-fixture";
const FIXTURE_ISSUE = 7;
const UNRELATED_ISSUE = 9;

type Host = "claude-code" | "opencode";

function selectionFor(operator: Host, crew: Host): string[] {
  return ["--claude", "--operator-host", operator, "--crew-host", crew];
}

const selection = selectionFor("claude-code", "opencode");

// Each host answers its own version, so the readiness static checks see both as installed.
const hostTools = {
  claude: 'echo "2.0.1 (Claude Code)"',
  opencode: 'echo "0.4.2"',
};

function issue(number: number, body: string): FakeIssue {
  return {
    number,
    state: "open",
    state_reason: null,
    closed_by: null,
    closed_at: null,
    updated_at: "2026-09-01T00:00:00Z",
    title: `Issue ${number}`,
    body,
  };
}

/** Answers every step with a report that satisfies the check that reads it. */
function goodReports(options: { crewHost?: string; operatorHost?: string } = {}) {
  return {
    loading: {
      step: "loading",
      host: options.operatorHost ?? "claude-code",
      instructions: ["AGENTS.md"],
      skills: ["operator"],
    },
    question: {
      step: "question",
      questionId: "probe-question-1",
      acknowledgedAt: "2026-09-22T10:00:00.000Z",
      answer: "The probe identity is the one in the brief.",
    },
    result: {
      step: "result",
      submissionId: "probe-result-1",
      artifacts: ["probe-note.md"],
    },
    review: {
      step: "review",
      host: options.crewHost ?? "opencode",
      axes: [
        {
          axis: "standards",
          startedAt: "2026-09-22T10:00:00.000Z",
          finishedAt: "2026-09-22T10:00:30.000Z",
        },
        {
          axis: "spec",
          startedAt: "2026-09-22T10:00:05.000Z",
          finishedAt: "2026-09-22T10:00:35.000Z",
        },
      ],
    },
    interruption: { step: "interruption", wrote: "partial.txt" },
  };
}

async function writeFixtureState(workspace: Workspace, state: GithubFakeState): Promise<void> {
  await Bun.write(`${workspace.github}/state.json`, `${JSON.stringify(state, null, 2)}\n`);
}

async function makeProbeWorkspace(
  options: { fixture?: boolean; operator?: Host; crew?: Host } = {},
): Promise<Workspace & { probeId: string; selection: string[] }> {
  const operator = options.operator ?? "claude-code";
  const crew = options.crew ?? "opencode";
  const workspace = await fixtures.make({
    tools: hostTools,
    // Operator refuses to configure a project that tracks its own local directory.
    files: { ".gitignore": "/.operator/\n" },
    config: {
      operator: { host: operator },
      crew: { host: crew },
      ...(options.fixture === false
        ? {}
        : {
            probe: {
              githubFixture: { repository: FIXTURE_REPOSITORY, issue: FIXTURE_ISSUE },
            },
          }),
    },
  });

  await writeFixtureState(workspace, {
    viewer: "operator-bot",
    nextCommentId: 1,
    issues: {
      [String(FIXTURE_ISSUE)]: issue(FIXTURE_ISSUE, "# Probe fixture\n\n## Decisions\n\n- none"),
      [String(UNRELATED_ISSUE)]: issue(UNRELATED_ISSUE, "An unrelated project issue."),
    },
    comments: {},
    events: {},
    subIssues: { [String(FIXTURE_ISSUE)]: [issue(11, "A sub-issue.")] },
    blockedBy: { [String(FIXTURE_ISSUE)]: [issue(12, "A blocking issue.")] },
  });

  await runJson(workspace, ["install", "--claude"]);
  const plan = await runJson(workspace, ["setup", "plan", "--claude"]);
  await runJson(workspace, [
    "setup",
    "apply",
    "--claude",
    "--approved-plan",
    plan.json.data.planId,
  ]);

  const chosen = selectionFor(operator, crew);
  const probe = await runJson(workspace, ["setup", "probe", "plan", ...chosen]);
  return { ...workspace, probeId: probe.json.data.probeId, selection: chosen };
}

async function applyProbe(
  workspace: Workspace & { probeId: string; selection: string[] },
  windowMs = "4000",
) {
  return runJson(
    workspace,
    ["setup", "probe", "apply", ...workspace.selection, "--approved-probe", workspace.probeId],
    workspace.repo,
    { OPERATOR_PROBE_OBSERVATION_MS: windowMs },
  );
}

/** Every Herdr call that creates or drives a resource. A version read drives nothing. */
async function launchCalls(workspace: Workspace): Promise<string[]> {
  return (await herdrCalls(workspace)).filter((one) => !one.startsWith("--version"));
}

type Observation = {
  name: string;
  state: string;
  detail: string;
  inputs: Record<string, string>;
  versions: Record<string, string>;
  outputs: string[];
  evidence: Array<{ label: string; path: string | null; identity: string | null }>;
  cleanup: { state: string; detail: string };
};

function observed(json: { data: { run: { observations: Observation[] } } }, name: string) {
  return json.data.run.observations.find((one) => one.name === name);
}

/** What the probe directory holds, so a test reads the resources instead of guessing at them. */
async function probeEntries(workspace: Workspace, pattern: string): Promise<string[]> {
  const root = `${workspace.repo}/.operator/local/probe`;
  return Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, dot: true, onlyFiles: false }));
}

describe("operator setup probe apply", () => {
  let workspace: Workspace & { probeId: string; selection: string[] };

  beforeEach(async () => {
    workspace = await makeProbeWorkspace();
    await seedProbeReports(workspace, goodReports());
    await seedProbePartial(workspace, "half of the synthetic work");
  }, PROBE_TIMEOUT_MS);

  test(
    "launches nothing without an approval that names the shown plan",
    async () => {
      const result = await runJson(workspace, ["setup", "probe", "apply", ...selection]);

      expect(result.exitCode).toBe(3);
      expect(result.json.reason).toBe("approval_required");
      expect(await launchCalls(workspace)).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "refuses an approval bound to an earlier plan revision",
    async () => {
      const result = await runJson(
        workspace,
        ["setup", "probe", "apply", ...selection, "--approved-probe", "0".repeat(64)],
        workspace.repo,
        { OPERATOR_PROBE_OBSERVATION_MS: "500" },
      );

      expect(result.exitCode).toBe(3);
      expect(result.json.reason).toBe("approval_stale");
      expect(await launchCalls(workspace)).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "proves the lifecycle, the project readiness, and the tracker fixture in one run",
    async () => {
      const result = await applyProbe(workspace);

      expect(result.json.reason).toBe("probe_completed");
      expect(result.exitCode).toBe(0);
      expect(
        result.json.data.run.observations
          .filter((one: Observation) => one.state !== "passed")
          .map((one: Observation) => `${one.name}: ${one.detail}`),
      ).toEqual([]);
      expect(result.json.data.readiness.state).toBe("ready");
      expect(result.json.data.readiness.claims).toEqual({
        readiness: "proven",
        release: "proven",
      });
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "records versions, inputs, outputs, evidence, and cleanup state for every observation",
    async () => {
      const result = await applyProbe(workspace);

      for (const one of result.json.data.run.observations as Observation[]) {
        expect(Object.keys(one.versions).length).toBeGreaterThan(0);
        expect(Object.keys(one.inputs).length).toBeGreaterThan(0);
        expect(one.cleanup.state).toMatch(/^(removed|retained|failed|not-applicable)$/);
      }
      expect(observed(result.json, "herdr-worktree")?.evidence.map((one) => one.label)).toContain(
        "test worktree",
      );
      expect(observed(result.json, "instruction-and-skill-loading")?.outputs).toContain(
        "AGENTS.md",
      );
      expect(observed(result.json, "worktree-removal")?.cleanup.state).toBe("removed");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "removes the Herdr test worktree it created and stops every host it launched",
    async () => {
      const result = await applyProbe(workspace);
      const calls = await herdrCalls(workspace);

      expect(calls.some((one) => one.startsWith("worktree create"))).toBe(true);
      expect(calls.some((one) => one.startsWith("worktree remove"))).toBe(true);
      expect(observed(result.json, "host-termination")?.state).toBe("passed");
      // The test worktree is gone, and the scratch repository stays until a cleanup is approved.
      expect(await probeEntries(workspace, "*/worktree")).toEqual([]);
      expect(await probeEntries(workspace, "*/repo/.git/HEAD")).toHaveLength(1);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "writes only to the configured fixture, never to another issue",
    async () => {
      await applyProbe(workspace);
      const calls = await githubCalls(workspace);
      const writes = calls.filter((one) => one.startsWith("POST") || one.startsWith("PATCH"));

      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((one) => one.includes(`/issues/${FIXTURE_ISSUE}`))).toBe(true);
      expect(calls.some((one) => one.includes(`/issues/${UNRELATED_ISSUE}`))).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "puts the fixture issue back as it found it",
    async () => {
      await applyProbe(workspace);
      const state: GithubFakeState = await Bun.file(`${workspace.github}/state.json`).json();

      expect(state.issues[String(FIXTURE_ISSUE)]?.state).toBe("open");
      expect(state.events[String(FIXTURE_ISSUE)]?.map((one) => one.event)).toEqual([
        "closed",
        "reopened",
      ]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "fails a check when the agent answers nothing inside its window",
    async () => {
      // The seeded answer goes away, so the launched agent writes no question report at all.
      await Bun.$`rm ${workspace.herdr}/probe/question.json`.quiet();

      const result = await applyProbe(workspace, "600");

      expect(result.exitCode).toBe(1);
      expect(result.json.reason).toBe("probe_run_failed");
      expect(observed(result.json, "question-and-answer")).toMatchObject({ state: "failed" });
      const readiness = await runJson(workspace, ["setup", "readiness", ...selection]);
      expect(readiness.json.data.state).toBe("blocked");
      expect(readiness.json.data.claims.readiness).toBe("blocked");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "needs the approval again for a rerun",
    async () => {
      const first = await applyProbe(workspace);
      expect(first.json.reason).toBe("probe_completed");

      const rerun = await runJson(workspace, ["setup", "probe", "apply", ...workspace.selection]);

      expect(rerun.exitCode).toBe(3);
      expect(rerun.json.reason).toBe("approval_required");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "keeps the tracker checks skipped and unverified when no fixture is configured",
    async () => {
      const bare = await makeProbeWorkspace({ fixture: false });
      await seedProbeReports(bare, goodReports());
      await seedProbePartial(bare, "half of the synthetic work");

      const result = await applyProbe(bare);

      expect(result.exitCode).toBe(3);
      expect(result.json.reason).toBe("probe_incomplete");
      expect(observed(result.json, "github-comment")).toMatchObject({ state: "skipped" });
      expect((await githubCalls(bare)).filter((one) => !one.endsWith("--version"))).toEqual([]);
      const readiness = await runJson(bare, ["setup", "readiness", ...selection]);
      expect(readiness.json.data.state).toBe("unverified");
      expect(readiness.json.data.claims.release).toBe("unverified");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "keeps every attempt, so a failed one survives a later run",
    async () => {
      await Bun.$`rm ${workspace.herdr}/probe/result.json`.quiet();
      await applyProbe(workspace, "600");
      await seedProbeReports(workspace, goodReports());
      await applyProbe(workspace);

      const recorded = await Bun.file(`${workspace.repo}/.operator/local/readiness.json`).json();

      expect(recorded.schemaVersion).toBe(2);
      expect(recorded.runs).toHaveLength(2);
      expect(
        recorded.runs[0].observations.find((one: Observation) => one.name === "result-reporting")
          ?.state,
      ).toBe("failed");
      expect(
        recorded.runs[1].observations.find((one: Observation) => one.name === "result-reporting")
          ?.state,
      ).toBe("passed");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "sends each host exactly the number of prompts the plan charged for",
    async () => {
      const plan = await runJson(workspace, ["setup", "probe", "plan", ...workspace.selection]);
      const declared = (plan.json.data.checks as Array<{ name: string }>).length;
      expect(declared).toBeGreaterThan(0);
      const charged = (plan.json.data.expectedCosts as string[])
        .filter((line) => line.includes("synthetic prompts"))
        .map((line) => Number(/(\d+) synthetic prompts/.exec(line)?.[1]));

      await applyProbe(workspace);
      const prompts = (await herdrCalls(workspace)).filter((one) =>
        one.startsWith("agent prompt "),
      );

      // The plan charges for the Operator host first and the Crew host second.
      expect(charged).toEqual([
        prompts.filter((one) => one.includes("-operator ")).length,
        prompts.filter((one) => one.includes("-crew ")).length,
      ]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "writes nothing to a fixture issue that is not open, and skips what needed it",
    async () => {
      const state: GithubFakeState = await Bun.file(`${workspace.github}/state.json`).json();
      const held = state.issues[String(FIXTURE_ISSUE)];
      expect(held).toBeDefined();
      await writeFixtureState(workspace, {
        ...state,
        issues: {
          ...state.issues,
          [String(FIXTURE_ISSUE)]: { ...(held as FakeIssue), state: "closed" },
        },
      });

      const result = await applyProbe(workspace);
      const after: GithubFakeState = await Bun.file(`${workspace.github}/state.json`).json();

      expect(observed(result.json, "github-closure")).toMatchObject({ state: "skipped" });
      expect(observed(result.json, "github-events")).toMatchObject({ state: "skipped" });
      // The probe restores nothing it did not do, so the issue keeps the state it was found in.
      expect(after.issues[String(FIXTURE_ISSUE)]?.state).toBe("closed");
      expect(after.events[String(FIXTURE_ISSUE)] ?? []).toEqual([]);
      expect((await githubCalls(workspace)).some((one) => one.startsWith("PATCH"))).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "reports the same mixed-host selection it launched",
    async () => {
      const result = await applyProbe(workspace);

      expect(observed(result.json, "mixed-host-operation")?.outputs).toEqual([
        "operator claude-code",
        "crew opencode",
      ]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "fails the mixed-host check when a host answers as another host",
    async () => {
      await seedProbeReports(workspace, goodReports({ crewHost: "claude-code" }));

      const result = await applyProbe(workspace);

      expect(observed(result.json, "mixed-host-operation")).toMatchObject({ state: "failed" });
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("operator setup probe cleanup", () => {
  test(
    "reports nothing to remove when no probe left a resource",
    async () => {
      const workspace = await makeProbeWorkspace();

      const result = await runJson(workspace, ["setup", "probe", "cleanup"]);

      expect(result.exitCode).toBe(0);
      expect(result.json.reason).toBe("probe_no_resources");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "needs its own approval before it removes a probe resource",
    async () => {
      const workspace = await makeProbeWorkspace();
      await seedProbeReports(workspace, goodReports());
      await seedProbePartial(workspace, "half of the synthetic work");
      await Bun.$`rm ${workspace.herdr}/probe/review.json`.quiet();
      await applyProbe(workspace, "600");

      const refused = await runJson(workspace, ["setup", "probe", "cleanup"]);

      expect(refused.exitCode).toBe(3);
      expect(refused.json.reason).toBe("approval_required");
      expect(refused.json.data.directories.length).toBeGreaterThan(0);

      const removed = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        refused.json.data.cleanupId,
      ]);

      expect(removed.exitCode).toBe(0);
      expect(removed.json.reason).toBe("probe_resources_removed");
      // The recorded observations stay, so the failed attempt survives its resources.
      const recorded = await Bun.file(`${workspace.repo}/.operator/local/readiness.json`).json();
      expect(recorded.runs).toHaveLength(1);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "removes nothing outside the directory probes write in",
    async () => {
      const workspace = await makeProbeWorkspace();
      await seedProbeReports(workspace, goodReports());
      await seedProbePartial(workspace, "half of the synthetic work");
      await applyProbe(workspace);
      const kept = `${workspace.repo}/.operator/local/crew-evidence.txt`;
      await Bun.write(kept, "evidence another part of Operator owns\n", { createPath: true });

      const refused = await runJson(workspace, ["setup", "probe", "cleanup"]);
      await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        refused.json.data.cleanupId,
      ]);

      expect(await Bun.file(kept).exists()).toBe(true);
      expect(await Bun.file(`${workspace.repo}/.operator/local/readiness.json`).exists()).toBe(
        true,
      );
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "refuses an approval that no longer names the resources it would remove",
    async () => {
      const workspace = await makeProbeWorkspace();
      await seedProbeReports(workspace, goodReports());
      await seedProbePartial(workspace, "half of the synthetic work");
      await Bun.$`rm ${workspace.herdr}/probe/review.json`.quiet();
      await applyProbe(workspace, "600");

      const result = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        "0".repeat(64),
      ]);

      expect(result.exitCode).toBe(3);
      expect(result.json.reason).toBe("approval_stale");
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("the compatibility matrix", () => {
  const pairings: Array<[Host, Host]> = [
    ["claude-code", "claude-code"],
    ["claude-code", "opencode"],
    ["opencode", "claude-code"],
    ["opencode", "opencode"],
  ];

  for (const [operator, crew] of pairings) {
    test(
      `proves the ${operator} Operator with the ${crew} Crew`,
      async () => {
        const workspace = await makeProbeWorkspace({ operator, crew });
        await seedProbeReports(workspace, goodReports({ operatorHost: operator, crewHost: crew }));
        await seedProbePartial(workspace, "half of the synthetic work");

        const result = await applyProbe(workspace);

        expect(result.json.reason).toBe("probe_completed");
        expect(observed(result.json, "mixed-host-operation")?.outputs).toEqual([
          `operator ${operator}`,
          `crew ${crew}`,
        ]);
      },
      PROBE_TIMEOUT_MS,
    );
  }

  test(
    "reaches no real Herdr and no real gh, whatever this machine holds",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.$`rm ${workspace.bin}/herdr ${workspace.bin}/gh`.quiet();

      const result = await runJson(workspace, ["setup", "probe", "plan", ...workspace.selection]);

      expect(result.json.reason).toBe("probe_blocked");
      expect(result.json.blockers.map((one: { check: string }) => one.check)).toEqual([
        "herdr",
        "github-integration",
      ]);
    },
    PROBE_TIMEOUT_MS,
  );
});
