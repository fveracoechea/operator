import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FakeIssue, GithubFakeState } from "./github-fake-state.ts";
import {
  githubCalls,
  herdrCalls,
  runJson,
  runOperator,
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
function goodReports(
  options: { crewHost?: string; operatorHost?: string; skills?: string[] } = {},
) {
  return {
    loading: {
      step: "loading",
      host: options.operatorHost ?? "claude-code",
      // The probe copies the project's own instruction files and installs its own skills into
      // the synthetic checkout, so a good answer names them. Naming more changes nothing.
      instructions: ["AGENTS.md", "CLAUDE.md"],
      skills: options.skills ?? ["operator"],
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
): Promise<Workspace & { probeId: string; selection: string[]; skills: string[] }> {
  const operator = options.operator ?? "claude-code";
  const crew = options.crew ?? "opencode";
  const config: {
    operator: { host: Host };
    crew: { host: Host };
    probe?: { githubFixture: { repository: string; issue: number } };
  } = { operator: { host: operator }, crew: { host: crew } };
  if (options.fixture !== false) {
    config.probe = { githubFixture: { repository: FIXTURE_REPOSITORY, issue: FIXTURE_ISSUE } };
  }
  const workspace = await fixtures.make({
    tools: hostTools,
    // Operator refuses to configure a project that tracks its own local directory.
    files: { ".gitignore": "/.operator/\n" },
    config,
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

  // The probe proves a release claim, so the project first selects the exact release it runs.
  const commit = "e".repeat(40);
  const update = await runJson(workspace, ["update", "plan", "--claude", "--commit", commit]);
  await runJson(workspace, [
    "update",
    "apply",
    "--claude",
    "--commit",
    commit,
    "--approved-update",
    update.json.data.updateId,
  ]);

  const chosen = selectionFor(operator, crew);
  const probe = await runJson(workspace, ["setup", "probe", "plan", ...chosen]);
  // The skills this release installs, read from the copy setup just made, so the canned answer
  // names what the probe really places instead of a list that drifts from the release.
  const skills = await Array.fromAsync(
    new Bun.Glob("*/SKILL.md").scan({ cwd: `${workspace.repo}/.claude/skills` }),
  );
  return {
    ...workspace,
    probeId: probe.json.data.probeId,
    selection: chosen,
    skills: skills.map((one) => one.split("/")[0] ?? one).toSorted(),
  };
}

async function applyProbe(
  workspace: Workspace & { probeId: string; selection: string[]; skills: string[] },
  windowMs = "4000",
) {
  return runJson(
    workspace,
    ["setup", "probe", "apply", ...workspace.selection, "--approved-probe", workspace.probeId],
    workspace.repo,
    { OPERATOR_PROBE_OBSERVATION_MS: windowMs },
  );
}

/** Read-only recovery inspection must not count as launching or driving an agent. */
async function launchCalls(workspace: Workspace): Promise<string[]> {
  return (await herdrCalls(workspace)).filter((one) =>
    [
      "worktree create ",
      "worktree remove ",
      "agent start ",
      "agent prompt ",
      "agent send-keys ",
      "pane split ",
    ].some((prefix) => one.startsWith(prefix)),
  );
}

type Observation = {
  name: string;
  state: string;
  detail: string;
  startedAt: string;
  finishedAt: string;
  inputs: Record<string, string>;
  versions: Record<string, string>;
  outputs: string[];
  evidence: Array<{ label: string; path: string | null; identity: string | null }>;
  cleanup: { state: string; detail: string };
};

function observed(json: { data: { attempt: { observations: Observation[] } } }, name: string) {
  return json.data.attempt.observations.find((one) => one.name === name);
}

/** What the probe directory holds, so a test reads the resources instead of guessing at them. */
async function probeEntries(workspace: Workspace, pattern: string): Promise<string[]> {
  const root = `${workspace.repo}/.operator/local/probe`;
  return Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, dot: true, onlyFiles: false }));
}

describe("operator setup probe apply", () => {
  let workspace: Workspace & { probeId: string; selection: string[]; skills: string[] };

  beforeEach(async () => {
    workspace = await makeProbeWorkspace();
    await seedProbeReports(workspace, goodReports({ skills: workspace.skills }));
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
        result.json.data.attempt.observations
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

      for (const one of result.json.data.attempt.observations as Observation[]) {
        expect(Object.keys(one.versions).length).toBeGreaterThan(0);
        expect(Object.keys(one.inputs).length).toBeGreaterThan(0);
        expect(one.cleanup.state).toMatch(/^(removed|retained|failed|not-applicable)$/);
      }
      expect(observed(result.json, "herdr-worktree")?.evidence.map((one) => one.label)).toContain(
        "test worktree",
      );
      // Each check names its own window, not the window of the whole attempt.
      const windows = (result.json.data.attempt.observations as Observation[]).map(
        (one) => `${one.startedAt}/${one.finishedAt}`,
      );
      expect(new Set(windows).size).toBeGreaterThan(1);
      for (const one of result.json.data.attempt.observations as Observation[]) {
        expect(Date.parse(one.startedAt)).toBeLessThanOrEqual(Date.parse(one.finishedAt));
      }
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
      expect(
        calls.some((one) =>
          /^worktree create .*--label repo probe [a-f0-9]{8} worktree /.test(one),
        ),
      ).toBe(true);
      expect(
        calls.some((one) =>
          /^workspace rename w-source repo probe [a-f0-9]{8} repository /.test(one),
        ),
      ).toBe(true);
      expect(
        calls.some((one) =>
          /^tab rename w1:t1 repo probe [a-f0-9]{8} Operator and Crew /.test(one),
        ),
      ).toBe(true);
      for (const call of calls.filter((one) => one.startsWith("agent start "))) {
        const name = call.split(" ")[2];
        expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
        expect(name).toMatch(/^probe-repo-[a-f0-9]{8}-(operator|crew)$/);
      }
      expect(
        calls.some((one) => one.startsWith("pane report-metadata w1:p1 --source operator")),
      ).toBe(true);
      expect(calls.some((one) => one.startsWith("worktree remove"))).toBe(true);
      expect(observed(result.json, "host-termination")?.state).toBe("passed");
      // The test worktree is gone, and the scratch repository stays until a cleanup is approved.
      expect(await probeEntries(workspace, "*/worktree")).toEqual([]);
      expect(await probeEntries(workspace, "*/repo/.git/HEAD")).toHaveLength(1);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "accepts the interactive shell Herdr returns to after an agent stops",
    async () => {
      await Bun.write(`${workspace.herdr}/pane-processes`, "101|zsh|zsh\n");
      await Bun.write(`${workspace.herdr}/keep-processes`, "");

      const result = await applyProbe(workspace);

      expect(observed(result.json, "host-termination")?.state).toBe("passed");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "still fails termination when a child command remains beside the shell",
    async () => {
      await Bun.write(
        `${workspace.herdr}/pane-processes`,
        "101|zsh|zsh\n4242|node|node server.js\n",
      );
      await Bun.write(`${workspace.herdr}/keep-processes`, "");

      const result = await applyProbe(workspace);

      expect(observed(result.json, "host-termination")?.state).toBe("failed");
      expect(observed(result.json, "host-termination")?.detail).toContain("node");
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
      expect(observed(result.json, "result-reporting")).toMatchObject({ state: "skipped" });
      expect(observed(result.json, "interruption")).toMatchObject({ state: "skipped" });
      const prompts = (await herdrCalls(workspace)).filter((one) =>
        one.startsWith("agent prompt "),
      );
      expect(prompts.filter((one) => one.includes("-operator "))).toHaveLength(2);
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
    "a missing optional wake plugin leaves a proven healthcheck successful",
    async () => {
      expect((await applyProbe(workspace)).json.reason).toBe("probe_completed");
      await Bun.write(`${workspace.herdr}/plugin-missing`, "");

      const health = await runJson(workspace, ["healthcheck", ...workspace.selection]);

      expect(health.exitCode).toBe(0);
      expect(health.json.reason).toBe("healthcheck_passed");
      expect(health.json.data.connections.herdr.state).toBe("passed");
      expect(health.json.data.wakePlugin.state).toBe("failed");
      expect(health.json.data.advisories).toContainEqual(
        expect.objectContaining({ check: "wake-plugin" }),
      );
      expect(health.json.blockers).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "reproves stale tracker evidence without launching hosts or replacing provider evidence",
    async () => {
      const first = await applyProbe(workspace);
      expect(first.json.reason).toBe("probe_completed");
      await Bun.write(`${workspace.github}/version-new`, "");
      const health = await runJson(workspace, ["healthcheck", ...workspace.selection]);
      expect(health.json.data.reproof).toContain("--stale-only");
      expect(
        health.json.data.readiness.unproven.map((one: { name: string }) => one.name),
      ).toContain("github-comment");
      expect(
        health.json.data.readiness.checks.find(
          (one: { name: string }) => one.name === "provider-compatibility",
        )?.state,
      ).toBe("passed");

      const plan = await runJson(workspace, [
        "setup",
        "probe",
        "plan",
        ...workspace.selection,
        "--stale-only",
      ]);
      expect(plan.json.data.staleOnly).toBe(true);
      expect(plan.json.data.checks.every((one: { group: string }) => one.group === "tracker")).toBe(
        true,
      );
      expect(
        plan.json.data.expectedCosts.some((line: string) => line.includes("0 synthetic prompts")),
      ).toBe(true);
      await Bun.write(`${workspace.github}/version-new`, "2.2.0");
      const staleApproval = await runJson(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--stale-only",
        "--approved-probe",
        plan.json.data.probeId,
      ]);
      expect(staleApproval.json.reason).toBe("approval_stale");
      await Bun.write(`${workspace.github}/version-new`, "2.1.0");
      const before = await launchCalls(workspace);
      const ran = await runJson(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--stale-only",
        "--approved-probe",
        plan.json.data.probeId,
      ]);
      expect(ran.exitCode).toBe(0);
      expect(
        ran.json.data.attempt.observations.every((one: Observation) =>
          one.name.startsWith("github-"),
        ),
      ).toBe(true);
      expect(ran.json.data.readiness.state).toBe("ready");
      expect(await launchCalls(workspace)).toEqual(before);
      const recorded = await Bun.file(`${workspace.repo}/.operator/local/readiness.json`).json();
      expect(recorded.attempts).toHaveLength(2);
      expect(
        recorded.attempts[0].observations.find(
          (one: Observation) => one.name === "provider-compatibility",
        )?.state,
      ).toBe("passed");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "an approved tracker reproof lists every fixture check and all writes it runs",
    async () => {
      const first = await applyProbe(workspace);
      expect(first.json.reason).toBe("probe_completed");
      const file = `${workspace.repo}/.operator/local/readiness.json`;
      const evidence = await Bun.file(file).json();
      const comment = evidence.attempts[0].observations.find(
        (one: Observation) => one.name === "github-comment",
      );
      comment.inputs["tool:github"] = "an earlier GitHub CLI";
      await Bun.write(file, JSON.stringify(evidence));

      const plan = await runJson(workspace, [
        "setup",
        "probe",
        "plan",
        ...workspace.selection,
        "--stale-only",
      ]);
      const expected = (first.json.data.attempt.observations as Observation[])
        .filter((one) => one.name.startsWith("github-"))
        .map((one) => one.name);
      expect(plan.json.data.checks.map((one: { name: string }) => one.name).toSorted()).toEqual(
        expected.toSorted(),
      );
      expect(plan.json.data.expectedCosts.join(" ")).toContain(
        "three comments written, one issue closed and reopened",
      );

      const before = await githubCalls(workspace);
      const ran = await runJson(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--stale-only",
        "--approved-probe",
        plan.json.data.probeId,
      ]);
      const writes = (await githubCalls(workspace))
        .slice(before.length)
        .filter((one) => one.startsWith("POST") || one.startsWith("PATCH"));
      expect(writes.filter((one) => one.startsWith("POST"))).toHaveLength(3);
      expect(writes.filter((one) => one.startsWith("PATCH"))).toHaveLength(2);
      expect(
        ran.json.data.attempt.observations.map((one: Observation) => one.name).toSorted(),
      ).toEqual(expected.toSorted());
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "an approved lifecycle reproof lists every check and every billed prompt it runs",
    async () => {
      const first = await applyProbe(workspace);
      expect(first.json.reason).toBe("probe_completed");
      const file = `${workspace.repo}/.operator/local/readiness.json`;
      const evidence = await Bun.file(file).json();
      const worktree = evidence.attempts[0].observations.find(
        (one: Observation) => one.name === "herdr-worktree",
      );
      worktree.inputs["tool:herdr"] = "an earlier Herdr CLI";
      await Bun.write(file, JSON.stringify(evidence));

      const plan = await runJson(workspace, [
        "setup",
        "probe",
        "plan",
        ...workspace.selection,
        "--stale-only",
      ]);
      const expected = (first.json.data.attempt.observations as Observation[])
        .filter((one) => !one.name.startsWith("github-"))
        .map((one) => one.name);
      expect(plan.json.data.checks.map((one: { name: string }) => one.name).toSorted()).toEqual(
        expected.toSorted(),
      );
      const before = await herdrCalls(workspace);
      const ran = await runJson(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--stale-only",
        "--approved-probe",
        plan.json.data.probeId,
      ]);
      const prompts = (await herdrCalls(workspace))
        .slice(before.length)
        .filter((one) => one.startsWith("agent prompt "));
      const charged = (plan.json.data.expectedCosts as string[])
        .filter((line) => line.includes("synthetic prompts"))
        .map((line) => Number(/(\d+) synthetic prompts/.exec(line)?.[1]));
      expect(charged).toEqual([
        prompts.filter((one) => one.includes("-operator ")).length,
        prompts.filter((one) => one.includes("-crew ")).length,
      ]);
      expect(
        ran.json.data.attempt.observations.map((one: Observation) => one.name).toSorted(),
      ).toEqual(expected.toSorted());
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "reproves Herdr evidence without writing again to the tracker fixture",
    async () => {
      expect((await applyProbe(workspace)).json.reason).toBe("probe_completed");
      await Bun.write(`${workspace.herdr}/version-new`, "");
      const plan = await runJson(workspace, [
        "setup",
        "probe",
        "plan",
        ...workspace.selection,
        "--stale-only",
      ]);
      expect(plan.json.data.checks.every((one: { group: string }) => one.group !== "tracker")).toBe(
        true,
      );
      const before = (await githubCalls(workspace)).filter((one) =>
        /^(POST|PATCH|PUT|DELETE) /.test(one),
      );
      const refused = await runJson(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--stale-only",
      ]);
      expect(refused.json.reason).toBe("approval_required");
      const ran = await runJson(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--stale-only",
        "--approved-probe",
        plan.json.data.probeId,
      ]);
      expect(ran.exitCode).toBe(0);
      expect(ran.json.data.readiness.state).toBe("ready");
      expect(
        (await githubCalls(workspace)).filter((one) => /^(POST|PATCH|PUT|DELETE) /.test(one)),
      ).toEqual(before);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "keeps fixture amendments independent across approved runs of the same plan",
    async () => {
      const first = await applyProbe(workspace);
      expect(observed(first.json, "github-amendment")?.state).toBe("passed");

      const second = await applyProbe(workspace);

      expect(observed(second.json, "github-amendment")?.state).toBe("passed");
      expect(second.json.reason).toBe("probe_completed");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "keeps the tracker checks skipped and unverified when no fixture is configured",
    async () => {
      const bare = await makeProbeWorkspace({ fixture: false });
      await seedProbeReports(bare, goodReports({ skills: bare.skills }));
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
      await seedProbeReports(workspace, goodReports({ skills: workspace.skills }));
      await applyProbe(workspace);

      const recorded = await Bun.file(`${workspace.repo}/.operator/local/readiness.json`).json();

      expect(recorded.schemaVersion).toBe(2);
      expect(recorded.attempts).toHaveLength(2);
      expect(
        recorded.attempts[0].observations.find(
          (one: Observation) => one.name === "result-reporting",
        )?.state,
      ).toBe("failed");
      expect(
        recorded.attempts[1].observations.find(
          (one: Observation) => one.name === "result-reporting",
        )?.state,
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
    "proves nothing from a fixture that holds no sub-issue and no blocking issue",
    async () => {
      const state: GithubFakeState = await Bun.file(`${workspace.github}/state.json`).json();
      await writeFixtureState(workspace, { ...state, subIssues: {}, blockedBy: {} });

      const result = await applyProbe(workspace);

      expect(result.json.reason).toBe("probe_incomplete");
      expect(observed(result.json, "github-sub-issues")).toMatchObject({ state: "skipped" });
      expect(observed(result.json, "github-dependencies")).toMatchObject({ state: "skipped" });
      const readiness = await runJson(workspace, ["setup", "readiness", ...selection]);
      expect(readiness.json.data.claims.release).toBe("unverified");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "tells an ordinary map comment apart from an amendment",
    async () => {
      const result = await applyProbe(workspace);
      const amendment = observed(result.json, "github-amendment");

      expect(amendment).toMatchObject({ state: "passed" });
      expect(amendment?.outputs).toContain("amendments 1");
      // The probe wrote one ordinary comment on the map, and the reader did not count it.
      expect(amendment?.outputs.some((one) => /^ordinary comments [1-9]/.test(one))).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "fails the loading check when the host does not load what the checkout holds",
    async () => {
      await seedProbeReports(
        workspace,
        // The host answers with a skill that is not in the checkout and omits the ones that are.
        goodReports({ skills: ["something-else"] }),
      );

      const result = await applyProbe(workspace);
      const loading = observed(result.json, "instruction-and-skill-loading");

      expect(loading).toMatchObject({ state: "failed" });
      expect(loading?.detail).toContain("did not report loading");
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "stages the project instructions and the installed skills for the launched host",
    async () => {
      const result = await applyProbe(workspace);
      const loading = observed(result.json, "instruction-and-skill-loading");

      expect(loading).toMatchObject({ state: "passed" });
      expect(workspace.skills).toContain("operator");
      for (const skill of workspace.skills) {
        expect(loading?.detail).toContain(skill);
      }
      expect(loading?.detail).toContain("AGENTS.md");
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
      await seedProbeReports(
        workspace,
        goodReports({ crewHost: "claude-code", skills: workspace.skills }),
      );

      const result = await applyProbe(workspace);

      expect(observed(result.json, "mixed-host-operation")).toMatchObject({ state: "failed" });
    },
    PROBE_TIMEOUT_MS,
  );
});

describe("operator setup probe cleanup", () => {
  test(
    "records a run before the first Herdr create request and cancels a crash before its effect",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/worktree-create.kill`, "");
      const crashed = await runOperator(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--approved-probe",
        workspace.probeId,
        "--json",
      ]);
      expect(crashed.exitCode).not.toBe(0);
      expect(await probeEntries(workspace, "*/run.json")).toHaveLength(1);
      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      expect(pending.json.data.resources[0]).toMatchObject({ worktree: "absent", agents: [] });
      const approved = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(approved.json.reason).toBe("probe_resources_removed");
      expect(await probeEntries(workspace, "*/run.json")).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "keeps a checkout when a stopped host left a child process in its pane",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/agent-start.lost`, "");
      await applyProbe(workspace);
      await Bun.write(
        `${workspace.herdr}/pane-processes`,
        "101|zsh|zsh\n4242|node|node server.js\n",
      );
      await Bun.write(`${workspace.herdr}/keep-processes`, "");
      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      const blocked = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(blocked.json.reason).toBe("probe_cleanup_blocked");
      expect(await probeEntries(workspace, "*/run.json")).toHaveLength(1);
      expect((await herdrCalls(workspace)).some((one) => one.startsWith("worktree remove"))).toBe(
        false,
      );
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "reads a tracker write with a lost reply and blocks a replay on repeat apply",
    async () => {
      const workspace = await makeProbeWorkspace();
      await seedProbeReports(workspace, goodReports({ skills: workspace.skills }));
      await seedProbePartial(workspace, "half of the synthetic work");
      await Bun.write(
        `${workspace.github}/faults.json`,
        JSON.stringify({ createComment: { kind: "applied-lost", remaining: 1 } }),
      );
      const first = await applyProbe(workspace);
      expect(first.json.reason).toBe("probe_run_failed");
      const writes = (await githubCalls(workspace)).filter((one) => one.startsWith("POST"));
      const second = await applyProbe(workspace);
      expect(second.json.reason).toBe("probe_incomplete_run");
      expect((await githubCalls(workspace)).filter((one) => one.startsWith("POST"))).toEqual(
        writes,
      );

      const status = await runJson(workspace, ["setup", "probe", "cleanup"]);
      expect(status.json.data.resources[0].fixture).toContain("resolution written");
      expect(status.json.data.resources[0].detail).toBeNull();
      const approved = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        status.json.data.cleanupId,
      ]);
      expect(approved.json.reason).toBe("probe_resources_removed");
      expect((await githubCalls(workspace)).filter((one) => one.startsWith("POST"))).toEqual(
        writes,
      );
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "recognizes an older interrupted run without a run record before deleting its scratch directory",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/agent-start.lost`, "");
      await applyProbe(workspace);
      const records = await probeEntries(workspace, "*/run.json");
      expect(records).toHaveLength(1);
      await Bun.$`rm ${workspace.repo}/.operator/local/probe/${records[0]}`.quiet();

      const repeated = await applyProbe(workspace);
      expect(repeated.json.reason).toBe("probe_incomplete_run");
      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      expect(pending.json.data.resources[0]).toMatchObject({
        fixture: "unrecorded",
        worktree: "present",
      });
      const approved = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(approved.json.reason).toBe("probe_resources_removed");
      expect(await probeEntries(workspace, "*/repo/.git/HEAD")).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "commits partial synthetic work before removing an interrupted worktree",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/agent-start.lost`, "");
      await applyProbe(workspace);
      const records = await probeEntries(workspace, "*/run.json");
      const directory = records[0]?.split("/")[0];
      expect(directory).toBeDefined();
      await Bun.write(
        `${workspace.repo}/.operator/local/probe/${directory}/worktree/partial.txt`,
        "partial work",
      );
      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      const approved = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(approved.json.reason).toBe("probe_resources_removed");
      expect(await probeEntries(workspace, "*/run.json")).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "finds a worktree whose create answer was lost and removes it under approval",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/worktree-create.lost`, "");
      const ran = await applyProbe(workspace);
      expect(ran.json.reason).toBe("probe_run_failed");
      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      expect(pending.json.data.resources).toEqual([
        expect.objectContaining({ worktree: "present", agents: [] }),
      ]);
      const approved = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(approved.json.reason).toBe("probe_resources_removed");
      expect((await herdrCalls(workspace)).some((one) => one.startsWith("worktree remove"))).toBe(
        true,
      );
      expect(await probeEntries(workspace, "*/run.json")).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "stops an agent whose start answer was lost without sending another start",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/agent-start.lost`, "");
      const ran = await applyProbe(workspace);
      expect(ran.json.reason).toBe("probe_run_failed");
      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      expect(pending.json.data.resources[0].agents).toHaveLength(1);
      const starts = (await herdrCalls(workspace)).filter((one) =>
        one.startsWith("agent start "),
      ).length;
      await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(
        (await herdrCalls(workspace)).filter((one) => one.startsWith("agent start ")),
      ).toHaveLength(starts);
      expect(await probeEntries(workspace, "*/run.json")).toEqual([]);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "refuses cleanup when the fixture changed since the interrupted run",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/agent-prompt.kill`, "");
      await runOperator(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--approved-probe",
        workspace.probeId,
        "--json",
      ]);
      const state: GithubFakeState = await Bun.file(`${workspace.github}/state.json`).json();
      const held = state.issues[String(FIXTURE_ISSUE)];
      await writeFixtureState(workspace, {
        ...state,
        issues: {
          ...state.issues,
          [String(FIXTURE_ISSUE)]: { ...(held as FakeIssue), state: "closed" },
        },
      });
      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      const stopped = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(stopped.json.reason).toBe("probe_cleanup_blocked");
      expect(await probeEntries(workspace, "*/run.json")).toHaveLength(1);
      expect((await herdrCalls(workspace)).some((one) => one.startsWith("agent send-keys"))).toBe(
        false,
      );
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "blocks a repeat after the CLI dies with a live agent, then cancels only this run",
    async () => {
      const workspace = await makeProbeWorkspace();
      await Bun.write(`${workspace.herdr}/agent-prompt.kill`, "");
      const crashed = await runOperator(workspace, [
        "setup",
        "probe",
        "apply",
        ...workspace.selection,
        "--approved-probe",
        workspace.probeId,
        "--json",
      ]);
      expect(crashed.exitCode).not.toBe(0);
      const agents = await Array.fromAsync(
        new Bun.Glob("*").scan({ cwd: `${workspace.herdr}/agents` }),
      );
      expect(agents).toHaveLength(1);
      expect(await Bun.file(`${workspace.repo}/.operator/local/readiness.json`).exists()).toBe(
        false,
      );
      await Bun.$`rm ${workspace.herdr}/agent-prompt.kill`.quiet();

      const before = (await herdrCalls(workspace)).filter((call) =>
        call.startsWith("worktree create"),
      ).length;
      const repeated = await applyProbe(workspace);
      expect(repeated.json.reason).toBe("probe_incomplete_run");
      expect(
        (await herdrCalls(workspace)).filter((call) => call.startsWith("worktree create")),
      ).toHaveLength(before);

      const pending = await runJson(workspace, ["setup", "probe", "cleanup"]);
      expect(pending.json.reason).toBe("approval_required");
      expect(pending.json.data.resources).toEqual(
        expect.arrayContaining([expect.objectContaining({ agents })]),
      );
      expect(await Bun.file(`${workspace.herdr}/agents/${agents[0]}`).exists()).toBe(true);

      const unrelated = "unrelated-agent";
      await Bun.write(`${workspace.herdr}/agents/${unrelated}`, "w0:p1");
      const cancelled = await runJson(workspace, [
        "setup",
        "probe",
        "cleanup",
        "--approved-cleanup",
        pending.json.data.cleanupId,
      ]);
      expect(cancelled.json.reason).toBe("probe_resources_removed");
      expect(await Bun.file(`${workspace.herdr}/agents/${agents[0]}`).exists()).toBe(false);
      expect(await Bun.file(`${workspace.herdr}/agents/${unrelated}`).exists()).toBe(true);
      expect(await probeEntries(workspace, "*/repo/.git/HEAD")).toEqual([]);
      expect(await Bun.file(`${workspace.repo}/.operator/local/readiness.json`).exists()).toBe(
        false,
      );
    },
    PROBE_TIMEOUT_MS,
  );

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
      await seedProbeReports(workspace, goodReports({ skills: workspace.skills }));
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
      expect(recorded.attempts).toHaveLength(1);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "removes nothing outside the directory probes write in",
    async () => {
      const workspace = await makeProbeWorkspace();
      await seedProbeReports(workspace, goodReports({ skills: workspace.skills }));
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
    "does not treat an unrelated repository under the scratch root as a probe run",
    async () => {
      const workspace = await makeProbeWorkspace();
      const unrelated = `${workspace.repo}/.operator/local/probe/unrelated/repo/.git/HEAD`;
      await Bun.write(unrelated, "ref: refs/heads/main\n", { createPath: true });

      const result = await runJson(workspace, ["setup", "probe", "cleanup"]);

      expect(result.json.reason).toBe("probe_no_resources");
      expect(await Bun.file(unrelated).exists()).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  test(
    "refuses an approval that no longer names the resources it would remove",
    async () => {
      const workspace = await makeProbeWorkspace();
      await seedProbeReports(workspace, goodReports({ skills: workspace.skills }));
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
        await seedProbeReports(
          workspace,
          goodReports({ operatorHost: operator, crewHost: crew, skills: workspace.skills }),
        );
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
