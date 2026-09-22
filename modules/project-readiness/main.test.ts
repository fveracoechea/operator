import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(label: string): Promise<string> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-${label}-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`.quiet();
  temporaryRoots.push(root);
  return root;
}

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const root = await temporaryDirectory("readiness");
  await Bun.$`git init -q ${root}`.quiet();
  for (const [path, content] of Object.entries(files)) {
    await Bun.write(`${root}/${path}`, content, { createPath: true });
  }
  return root;
}

/**
 * Tool presence is observed through the path, so the path is the boundary the tests control.
 * Bun and Git stay real, because the CLI and the setup plan run them for their own work.
 */
async function makePath(tools: Record<string, string>): Promise<string> {
  const directory = await temporaryDirectory("bin");
  for (const [name, script] of Object.entries(tools)) {
    await Bun.write(`${directory}/${name}`, `#!/bin/sh\n${script}\n`);
    await Bun.$`chmod +x ${directory}/${name}`.quiet();
  }
  await Bun.$`ln -s ${process.execPath} ${directory}/bun`.quiet();
  return directory;
}

const everyTool = {
  git: null,
  herdr: 'echo "herdr 0.9.0"',
  gh: 'echo "gh version 2.60.0 (2025-01-01)"',
  claude: 'echo "2.0.1 (Claude Code)"',
  opencode: 'echo "0.4.2"',
};

async function makeFullPath(
  overrides: Partial<Record<keyof typeof everyTool, string | null>> = {},
): Promise<string> {
  const chosen = { ...everyTool, ...overrides };
  const scripts: Record<string, string> = {};
  for (const [name, script] of Object.entries(chosen)) {
    if (script !== null) {
      scripts[name] = script;
    }
  }

  const directory = await makePath(scripts);
  if (chosen.git === null) {
    await Bun.$`ln -s ${Bun.which("git")} ${directory}/git`.quiet();
  }
  return directory;
}

async function runOperator(root: string, path: string, args: string[]) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: root,
    env: { ...process.env, PATH: path },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function runJson(root: string, path: string, args: string[]) {
  const result = await runOperator(root, path, [...args, "--json"]);
  return { ...result, json: JSON.parse(result.stdout) };
}

async function configure(root: string, path: string, targets: string[]): Promise<void> {
  await runJson(root, path, ["install", ...targets]);
  const plan = await runJson(root, path, ["setup", "plan", ...targets]);
  await runJson(root, path, [
    "setup",
    "apply",
    ...targets,
    "--approved-plan",
    plan.json.data.planId,
  ]);
}

type ReportedCheck = {
  name: string;
  target: string | null;
  kind: string;
  state: string;
  reason: string | null;
  detail: string;
  nextAction: string | null;
  conflict: boolean;
  paths: string[];
};

function checkNamed(
  json: { data: { checks: ReportedCheck[] } },
  name: string,
  target: string | null = null,
): ReportedCheck | undefined {
  return json.data.checks.find((check) => check.name === name && check.target === target);
}

async function recordLiveEvidence(
  root: string,
  inputs: Record<string, string>,
  names: string[],
  state: "passed" | "failed" | "skipped" = "passed",
): Promise<void> {
  await Bun.write(
    `${root}/.operator/local/readiness.json`,
    `${JSON.stringify({
      schemaVersion: 2,
      runs: [
        {
          probeId: "f".repeat(64),
          planRevision: 2,
          approvedProbeId: "f".repeat(64),
          startedAt: "2026-09-21T10:00:00.000Z",
          finishedAt: "2026-09-21T10:01:00.000Z",
          targets: ["claude-code"],
          versions: { operator: "0.0.0" },
          observations: names.map((name) => ({
            name,
            state,
            detail: "Proven by the approved live probe.",
            startedAt: "2026-09-21T10:00:00.000Z",
            finishedAt: "2026-09-21T10:00:30.000Z",
            inputs,
            versions: { herdr: "0.9.0" },
            outputs: [],
            evidence: [],
            cleanup: { state: "not-applicable", detail: "Nothing was created." },
          })),
          cleanup: { state: "retained", detail: "The scratch repository stays.", resources: [] },
        },
      ],
    })}\n`,
    { createPath: true },
  );
}

const liveCheckNames = [
  "herdr-worktree",
  "agent-launch",
  "instruction-and-skill-loading",
  "bounded-observation",
  "question-and-answer",
  "result-reporting",
  "review-sub-agents",
  "mixed-host-operation",
  "interruption",
  "explicit-takeover",
  "host-termination",
  "worktree-removal",
  "github-comment",
  "github-pagination",
  "github-amendment",
  "github-dependencies",
  "github-sub-issues",
  "github-events",
  "github-closure",
  "provider-compatibility",
];

describe("operator setup readiness", () => {
  test("refuses to guess a target", async () => {
    const path = await makeFullPath();
    const root = await makeProject();

    const result = await runJson(root, path, ["setup", "readiness"]);

    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ outcome: "invalid", reason: "missing_target" });
  });

  test("reports a configured project with no live evidence as unverified, never ready", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("readiness_unverified");
    expect(result.json.data.state).toBe("unverified");
    expect(result.json.data.configured).toBe(true);
    expect(checkNamed(result.json, "bun")?.state).toBe("passed");
    expect(checkNamed(result.json, "herdr")?.state).toBe("passed");
    expect(checkNamed(result.json, "github-integration")?.state).toBe("passed");
    expect(checkNamed(result.json, "lock-data")?.state).toBe("passed");
    expect(checkNamed(result.json, "operator-release")?.state).toBe("passed");
    expect(checkNamed(result.json, "settings")?.state).toBe("passed");
    expect(checkNamed(result.json, "skill-contents", "claude-code")?.state).toBe("passed");
    expect(checkNamed(result.json, "instruction-loading", "claude-code")?.state).toBe("passed");
    expect(result.json.data.unproven.map((check: { name: string }) => check.name)).toEqual(
      liveCheckNames,
    );
  });

  test("records the operating system it observed", async () => {
    const path = await makeFullPath();
    const root = await makeProject();

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.json.data.platform).toBe(process.platform);
    expect(["linux", "darwin"]).toContain(result.json.data.platform);
    expect(result.json.data.inputs.platform).toBe(`${process.platform}/${process.arch}`);
  });

  test("blocks when a tool the workflow needs is not installed", async () => {
    const path = await makeFullPath({ herdr: null });
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("readiness_blocked");
    expect(result.json.data.state).toBe("blocked");
    expect(checkNamed(result.json, "herdr")).toMatchObject({
      state: "failed",
      reason: "tool_unavailable",
      nextAction: "Install Herdr, then check again.",
    });
  });

  test("refuses an unavailable explicit host instead of substituting another", async () => {
    const path = await makeFullPath({ opencode: null });
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "opencode",
    ]);

    expect(result.json.data.state).toBe("blocked");
    expect(checkNamed(result.json, "operator-selection")).toMatchObject({
      state: "failed",
      reason: "host_unavailable",
    });
    expect(result.json.data.selection.operator.host).toBe("opencode");
    expect(result.json.data.selection.operator.hostSource).toBe("session-override");
  });

  test("does not choose a host when nothing names one", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(checkNamed(result.json, "operator-selection")).toMatchObject({
      state: "unverified",
      reason: "host_unnamed",
    });
    expect(result.json.data.state).toBe("unverified");
  });

  test("applies session override, project configuration, and host default field by field", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude", "--opencode"]);
    await Bun.write(
      `${root}/.operator/config.json`,
      `${JSON.stringify({ operator: { host: "opencode", model: "big" }, crew: {} }, null, 2)}\n`,
    );

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--opencode",
      "--operator-host",
      "claude-code",
    ]);

    expect(result.json.data.selection).toEqual({
      operator: {
        host: "claude-code",
        hostSource: "session-override",
        model: "big",
        modelSource: "project-configuration",
      },
      crew: {
        host: "claude-code",
        hostSource: "operator-host",
        model: null,
        modelSource: "host-default",
      },
    });
    expect(result.json.data.appliesTo).toBe("new-launches");
  });

  test("blocks a project that was never configured", async () => {
    const path = await makeFullPath();
    const root = await makeProject();

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.json.data.configured).toBe(false);
    expect(checkNamed(result.json, "configuration")).toMatchObject({
      state: "failed",
      reason: "not_configured",
    });
    expect(checkNamed(result.json, "skill-contents", "claude-code")).toMatchObject({
      state: "failed",
      reason: "skills_missing",
    });
  });

  test("blocks a discoverable skill copy that differs from this release", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    await Bun.write(`${root}/.claude/skills/operator/SKILL.md`, "changed by hand\n");

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.exitCode).toBe(4);
    expect(result.json.reason).toBe("readiness_blocked");
    expect(checkNamed(result.json, "skill-contents", "claude-code")).toMatchObject({
      state: "failed",
      reason: "skill_copy_modified",
      conflict: true,
      paths: [".claude/skills/operator/SKILL.md"],
    });
  });

  test("reports one installed target and one missing target separately", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, ["setup", "readiness", "--claude", "--opencode"]);

    expect(checkNamed(result.json, "skill-contents", "claude-code")?.state).toBe("passed");
    expect(checkNamed(result.json, "instruction-loading", "claude-code")?.state).toBe("passed");
    expect(checkNamed(result.json, "skill-contents", "opencode")).toMatchObject({
      state: "failed",
      reason: "skills_missing",
    });
    expect(checkNamed(result.json, "instruction-loading", "opencode")?.state).toBe("passed");
  });

  test("permits a duplicate skill copy only while both copies match this release", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude", "--opencode"]);
    await Bun.write(`${root}/.agents/skills/operator/SKILL.md`, "changed by hand\n");

    const result = await runJson(root, path, ["setup", "readiness", "--claude", "--opencode"]);

    expect(result.exitCode).toBe(4);
    expect(checkNamed(result.json, "skill-contents", "claude-code")?.state).toBe("passed");
    expect(checkNamed(result.json, "skill-contents", "opencode")).toMatchObject({
      state: "failed",
      reason: "skill_copy_modified",
      conflict: true,
      paths: [".agents/skills/operator/SKILL.md"],
    });
  });

  test("reports one available host and one unavailable host separately", async () => {
    const path = await makeFullPath({ opencode: null });
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
      "--crew-host",
      "opencode",
    ]);

    expect(checkNamed(result.json, "operator-selection")?.state).toBe("passed");
    expect(checkNamed(result.json, "crew-selection")).toMatchObject({
      state: "failed",
      reason: "host_unavailable",
    });
    expect(result.json.data.state).toBe("blocked");
  });

  test("names the selected model in the checked selection", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
      "--operator-model",
      "opus",
    ]);

    expect(checkNamed(result.json, "operator-selection")?.detail).toContain(
      "model opus from session-override",
    );
    expect(checkNamed(result.json, "crew-selection")?.detail).toContain("the host-default model");
  });

  test("is not configured while one selected target holds no skill copy", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, ["setup", "readiness", "--claude", "--opencode"]);

    expect(result.json.data.configured).toBe(false);
  });

  test("blocks an invalid configuration without repairing it", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    await Bun.write(`${root}/.operator/config.json`, `{ "operatr": {} }\n`);

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.exitCode).toBe(4);
    expect(checkNamed(result.json, "configuration")).toMatchObject({
      state: "failed",
      reason: "invalid_configuration",
      conflict: true,
    });
  });

  test("reports readiness for a person without JSON", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runOperator(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);

    expect(result.stdout).toContain("Operator readiness: unverified");
    expect(result.stdout).toContain("Configured: yes");
    expect(result.stdout).toContain("Operator host: claude-code (session-override)");
    expect(result.stdout).toContain("This selection reaches new launches only.");
  });

  test("blocks an Operator installation that kept no lock data", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const installation = await temporaryDirectory("installation");
    const source = new URL("../../", import.meta.url).pathname;
    await Bun.$`cp -R ${source}cli.ts ${source}package.json ${source}modules ${source}skills ${installation}/`.quiet();
    await Bun.$`ln -s ${source}node_modules ${installation}/node_modules`.quiet();

    const child = Bun.spawn(
      ["bun", `${installation}/cli.ts`, "setup", "readiness", "--claude", "--json"],
      {
        cwd: root,
        env: { ...process.env, PATH: path },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const json = JSON.parse(stdout);

    expect(json.data.state).toBe("blocked");
    expect(json.data.release.lock).toEqual({ name: null, state: "missing" });
    expect(checkNamed(json, "lock-data")).toMatchObject({
      state: "failed",
      reason: "lock_data_missing",
    });
  });

  test("writes nothing while it answers", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const before = await Bun.$`git -C ${root} status --porcelain --ignored`.text();

    await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(await Bun.$`git -C ${root} status --porcelain --ignored`.text()).toBe(before);
  });
});

describe("recorded live readiness evidence", () => {
  test("reports ready only once every required live check is proven", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);
    await recordLiveEvidence(root, first.json.data.inputs, liveCheckNames);

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("readiness_ready");
    expect(result.json.data.state).toBe("ready");
    expect(result.json.blockers).toEqual([]);
  });

  test("stays unverified when one required live check has no evidence", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);
    await recordLiveEvidence(
      root,
      first.json.data.inputs,
      liveCheckNames.filter((name) => name !== "review-sub-agents"),
    );

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);

    expect(result.json.data.state).toBe("unverified");
    expect(checkNamed(result.json, "review-sub-agents")).toMatchObject({
      state: "unverified",
      reason: "live_check_missing",
    });
  });

  test("invalidates only the evidence whose own inputs changed", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);
    await recordLiveEvidence(root, first.json.data.inputs, liveCheckNames);

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
      "--crew-model",
      "a-different-model",
    ]);

    expect(result.json.data.state).toBe("unverified");
    // The worktree check never depended on the selection, so its evidence survives.
    expect(checkNamed(result.json, "herdr-worktree")?.state).toBe("passed");
    expect(checkNamed(result.json, "provider-compatibility")).toMatchObject({
      state: "stale",
      reason: "evidence_stale",
    });
    expect(checkNamed(result.json, "review-sub-agents")?.state).toBe("stale");
  });

  test("invalidates the checks that load skills when the installed copies change", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude", "--opencode"]);
    const first = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--opencode",
      "--operator-host",
      "claude-code",
    ]);
    await recordLiveEvidence(root, first.json.data.inputs, liveCheckNames);
    await rm(`${root}/.agents/skills/operator`, { force: true, recursive: true });

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--opencode",
      "--operator-host",
      "claude-code",
    ]);

    expect(checkNamed(result.json, "instruction-and-skill-loading")?.state).toBe("stale");
    expect(checkNamed(result.json, "question-and-answer")?.state).toBe("passed");
  });

  test("keeps skill evidence when the request names fewer targets", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude", "--opencode"]);
    const first = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--opencode",
      "--operator-host",
      "claude-code",
    ]);
    await recordLiveEvidence(root, first.json.data.inputs, liveCheckNames);

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);

    expect(checkNamed(result.json, "instruction-and-skill-loading")?.state).toBe("passed");
    expect(result.json.data.state).toBe("ready");
  });

  test("invalidates evidence that was proven on another operating system", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);
    await recordLiveEvidence(
      root,
      { ...first.json.data.inputs, platform: "another-system/another-chip" },
      liveCheckNames,
    );

    const result = await runJson(root, path, [
      "setup",
      "readiness",
      "--claude",
      "--operator-host",
      "claude-code",
    ]);

    expect(checkNamed(result.json, "herdr-worktree")).toMatchObject({
      state: "stale",
      reason: "evidence_stale",
    });
    // Provider compatibility never depended on the operating system.
    expect(checkNamed(result.json, "provider-compatibility")?.state).toBe("passed");
  });

  test("leaves a skipped check unverified and holds back both claims", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, ["setup", "readiness", "--claude"]);
    await recordLiveEvidence(root, first.json.data.inputs, liveCheckNames, "skipped");

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.exitCode).toBe(3);
    expect(result.json.data.state).toBe("unverified");
    expect(checkNamed(result.json, "github-comment")).toMatchObject({
      state: "unverified",
      reason: "live_check_skipped",
    });
    expect(result.json.data.claims).toEqual({
      readiness: "unverified",
      release: "unverified",
    });
  });

  test("blocks the release claim on a failed check that feeds it", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, ["setup", "readiness", "--claude"]);
    await recordLiveEvidence(root, first.json.data.inputs, ["github-closure"], "failed");

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.exitCode).toBe(3);
    expect(result.json.data.state).toBe("blocked");
    expect(result.json.data.claims.release).toBe("blocked");
    expect(result.json.data.claims.readiness).toBe("blocked");
  });

  test("refuses a recorded result that names no approved probe", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, ["setup", "readiness", "--claude"]);
    await Bun.write(
      `${root}/.operator/local/readiness.json`,
      `${JSON.stringify({
        schemaVersion: 1,
        checks: [
          {
            name: "herdr-worktree",
            state: "passed",
            observedAt: "2026-09-21T10:00:00.000Z",
            detail: "Recorded by hand.",
            inputs: first.json.data.inputs,
          },
        ],
      })}\n`,
      { createPath: true },
    );

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.exitCode).toBe(4);
    expect(checkNamed(result.json, "readiness-evidence")).toMatchObject({
      state: "failed",
      reason: "unreadable_evidence",
    });
  });

  test("blocks on a recorded evidence file it cannot read", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    await Bun.write(`${root}/.operator/local/readiness.json`, "{ not json\n", { createPath: true });

    const result = await runJson(root, path, ["setup", "readiness", "--claude"]);

    expect(result.exitCode).toBe(4);
    expect(checkNamed(result.json, "readiness-evidence")).toMatchObject({
      state: "failed",
      reason: "unreadable_evidence",
      conflict: true,
    });
  });
});

describe("operator setup probe", () => {
  const ready = ["--claude", "--operator-host", "claude-code", "--crew-host", "opencode"];

  test("shows the hosts, models, provider use, and temporary resources before any launch", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, ["setup", "probe", "plan", ...ready]);

    expect(result.exitCode).toBe(0);
    expect(result.json.reason).toBe("probe_plan_ready");
    expect(result.json.data.probeId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.json.data.planRevision).toBeGreaterThan(0);
    expect(result.json.data.agents.operator.host).toBe("claude-code");
    expect(result.json.data.agents.crew.host).toBe("opencode");
    expect(result.json.data.agents.crew.model).toBe(null);
    expect(result.json.data.providerUse.join(" ")).toContain("billed");
    expect(result.json.data.temporaryResources.length).toBeGreaterThan(0);
    expect(result.json.data.checks.map((check: { name: string }) => check.name)).toEqual(
      liveCheckNames,
    );
  });

  test("shows the credentials, the expected costs, and the cleanup before any launch", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runOperator(root, path, ["setup", "probe", "plan", ...ready]);
    const shown = await runJson(root, path, ["setup", "probe", "plan", ...ready]);

    expect(result.stdout).toContain("Credentials required:");
    expect(result.stdout).toContain("Expected costs:");
    expect(result.stdout).toContain("Cleanup:");
    expect(shown.json.data.credentials.join(" ")).toContain("Provider credentials");
    expect(shown.json.data.expectedCosts.join(" ")).toContain("synthetic prompts");
    // No fixture is configured, so the plan says the tracker checks reach nothing.
    expect(shown.json.data.fixture).toBe(null);
    expect(shown.json.data.credentials.join(" ")).toContain("No probe fixture is configured");
    expect(shown.json.data.cleanup.join(" ")).toContain("removes no Operative worktree");
  });

  test("names the configured fixture and the token it needs", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    await Bun.write(
      `${root}/.operator/config.json`,
      `${JSON.stringify({
        crew: { host: "claude-code" },
        probe: { githubFixture: { repository: "someone/probe-fixture", issue: 7 } },
      })}\n`,
    );

    const result = await runJson(root, path, ["setup", "probe", "plan", ...ready]);

    expect(result.json.data.fixture).toEqual({ repository: "someone/probe-fixture", issue: 7 });
    expect(result.json.data.credentials.join(" ")).toContain("GitHub token");
    expect(result.json.data.expectedCosts.join(" ")).toContain("someone/probe-fixture#7");
  });

  test("makes an approval stale when the plan itself changes", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const first = await runJson(root, path, ["setup", "probe", "plan", ...ready]);
    await Bun.write(
      `${root}/.operator/config.json`,
      `${JSON.stringify({
        crew: { host: "claude-code" },
        probe: { githubFixture: { repository: "someone/probe-fixture", issue: 7 } },
      })}\n`,
    );

    const second = await runJson(root, path, ["setup", "probe", "plan", ...ready]);

    expect(second.json.data.probeId).not.toBe(first.json.data.probeId);
  });

  test("names the same targets and overrides in the approval it asks for", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const plan = await runOperator(root, path, ["setup", "probe", "plan", ...ready]);
    const approval = plan.stdout
      .split("\n")
      .find((line) => line.startsWith("Approve with: "))
      ?.replace("Approve with: operator ", "");

    expect(approval).toBeDefined();
    const applied = await runJson(root, path, (approval ?? "").split(" "));

    expect(applied.json.reason).toBe("live_probe_unavailable");
  });

  test("refuses to plan a probe for a blocked project", async () => {
    const path = await makeFullPath({ herdr: null });
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, ["setup", "probe", "plan", ...ready]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("probe_blocked");
  });

  test("refuses to launch without an approval", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);

    const result = await runJson(root, path, ["setup", "probe", "apply", ...ready]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("approval_required");
  });

  test("refuses an approval that no longer matches the shown plan", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const plan = await runJson(root, path, ["setup", "probe", "plan", ...ready]);

    const result = await runJson(root, path, [
      "setup",
      "probe",
      "apply",
      "--claude",
      "--operator-host",
      "claude-code",
      "--crew-host",
      "claude-code",
      "--approved-probe",
      plan.json.data.probeId,
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("approval_stale");
  });

  test("leaves the configuration unverified while this release runs no live check", async () => {
    const path = await makeFullPath();
    const root = await makeProject();
    await configure(root, path, ["--claude"]);
    const plan = await runJson(root, path, ["setup", "probe", "plan", ...ready]);
    const before = await Bun.$`git -C ${root} status --porcelain --ignored`.text();

    const result = await runJson(root, path, [
      "setup",
      "probe",
      "apply",
      ...ready,
      "--approved-probe",
      plan.json.data.probeId,
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.json.reason).toBe("live_probe_unavailable");
    expect(await Bun.$`git -C ${root} status --porcelain --ignored`.text()).toBe(before);
  });
});
