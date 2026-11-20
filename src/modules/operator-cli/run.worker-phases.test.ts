import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";
import { Database } from "bun:sqlite";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { z } from "zod";

let device: Awaited<ReturnType<typeof workerDevice>>;
afterEach(async () => {
  if (device !== undefined) await rm(device.root, { recursive: true, force: true });
});

test("every command result names the kind, the phase, and the next command", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#383",
    assignments: [
      {
        key: "research",
        kind: "research",
        trackerKey: "github:example/one#1",
        instructions: "Investigate.",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "research");
  const options = { pane: worker.paneId };
  const asked = await device.run(
    [
      "question",
      "ask",
      "--key",
      "scope",
      "--file",
      await device.writeText("question.md", "Which scope?"),
    ],
    options,
  );
  expect(asked.output).toMatchObject({
    kind: "research",
    phase: "investigate",
    next: { command: "operator question wait --key scope" },
  });
  const invalid = await device.run(["report", "resume"], options);
  expect(invalid.output).toMatchObject({
    outcome: "refused",
    kind: "research",
    phase: "investigate",
    next: { command: "operator report submit --file <file>" },
    state: { report_submitted: false },
  });
  const submitted = await device.run(
    [
      "report",
      "submit",
      "--file",
      await device.writeReport("report.md", {
        conclusion: "Done.",
        evidence: ["Investigated the fixture."],
        unresolved: [],
        decisions: [],
        files: [],
      }),
    ],
    options,
  );
  expect(submitted.code, submitted.stderr).toBe(0);
  expect(submitted.output).toMatchObject({
    kind: "research",
    phase: "acceptance",
    next: { decider: "super-agent" },
  });
  const followUp = `${device.root}/follow-up.md`;
  await Bun.write(followUp, "Check one more fact.");
  expect(
    (
      await device.run([
        "report",
        "return",
        "--source",
        source,
        "--assignment",
        "research",
        "--file",
        followUp,
      ])
    ).code,
  ).toBe(0);
  const returned = await device.run(
    ["report", "submit", "--file", `${device.root}/drafts/report.md`],
    options,
  );
  expect(returned.output).toMatchObject({
    reason: "report_returned",
    kind: "research",
    phase: "report",
    next: { command: "operator report resume" },
  });
  expect((await device.run(["report", "resume"], options)).output).toMatchObject({
    kind: "research",
    phase: "report",
    next: { command: "operator report submit --file <file>" },
  });
  expect(
    (await device.run(["report", "submit", "--file", `${device.root}/drafts/report.md`], options))
      .output,
  ).toMatchObject({ kind: "research", phase: "acceptance", data: { report: 2 } });
});

test("a phase exit command refuses until its guard holds, and names the next command", async () => {
  device = await workerDevice({ github: true });
  const source = await device.register({
    trackerKey: "github:example/one#383",
    assignments: [
      {
        key: "build",
        kind: "implementation",
        trackerKey: "github:example/one#1",
        instructions: "Build.",
        dependencies: [],
        branch: "task/build",
      },
    ],
  });
  const worker = await device.dispatch(source, "build");
  expect(worker.worktreePath).not.toBeNull();
  const cwd = worker.worktreePath ?? "";
  const options = { pane: worker.paneId, cwd };
  const head = (await device.exec(["git", "rev-parse", "HEAD"], cwd)).stdout.trim();
  for (const command of [
    ["round", "--file", "missing.json"],
    ["wait", "--timeout", "0"],
    ["merge"],
  ]) {
    expect((await device.run(["pr", ...command], options)).output).toMatchObject({
      reason: "pr_not_associated",
      kind: "implementation",
      phase: "build",
      next: { command: "operator pr associate" },
      state: { pr_associated: false },
    });
  }
  const missing = await device.run(["pr", "ready", "--file", "missing.json"], options);
  expect(missing.output).toMatchObject({
    reason: "pr_not_associated",
    kind: "implementation",
    phase: "build",
    next: { command: "operator pr associate" },
    state: { pr_associated: false },
  });
  const github = `${device.root}/github.json`;
  await Bun.write(
    github,
    JSON.stringify({
      pulls: [
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          headRefName: "task/build",
          headRepository: "example/one",
          state: "OPEN",
          head,
          isDraft: true,
        },
      ],
    }),
  );
  await Bun.write(`${cwd}/pending.txt`, "not committed");
  expect((await device.exec(["git", "config", "status.showUntrackedFiles", "no"], cwd)).code).toBe(
    0,
  );
  const dirty = await device.run(["pr", "associate"], options);
  expect(dirty.output).toMatchObject({
    reason: "pr_worktree_unclean",
    kind: "implementation",
    phase: "build",
    state: { worktree_clean: false },
  });
  expect(dirty.stderr.trim().split("\n")).toHaveLength(3);
  const unrecorded = await device.run(["source", "show", "--source", source]);
  expect(unrecorded.output).toMatchObject({ data: { pullRequests: [] } });
  await rm(`${cwd}/pending.txt`);
  const associated = await device.run(["pr", "associate"], options);
  expect(associated.code, associated.stderr).toBe(0);
  expect(associated.output).toMatchObject({
    kind: "implementation",
    phase: "feedback",
    next: { command: "operator pr wait" },
  });
  const waited = await device.run(["pr", "wait", "--timeout", "0"], options);
  expect(waited.output).toMatchObject({
    kind: "implementation",
    phase: "feedback",
    next: { command: "operator pr wait" },
  });
  expect((await device.run(["pr", "merge"], options)).output).toMatchObject({
    reason: "pr_merge_blocked",
    next: { command: "operator pr wait" },
    state: { conditions: { approved: false, checksPassing: false } },
  });
  const pull = {
    number: 7,
    url: "https://github.com/example/one/pull/7",
    headRefName: "task/build",
    headRepository: "example/one",
    state: "OPEN",
    head,
    reviewDecision: "APPROVED",
    checks: [{ name: "test", conclusion: "SUCCESS" }],
  };
  await Bun.write(github, JSON.stringify({ pulls: [{ ...pull, isDraft: true }] }));
  expect((await device.run(["pr", "wait", "--timeout", "0"], options)).output).toMatchObject({
    reason: "pr_wait_timed_out",
  });
  expect((await device.run(["pr", "merge"], options)).output).toMatchObject({
    reason: "pr_merge_blocked",
    state: { conditions: { notDraft: false } },
  });
  await Bun.write(github, JSON.stringify({ pulls: [{ ...pull, isDraft: false }] }));
  expect((await device.run(["pr", "merge"], options)).output).toMatchObject({
    reason: "pr_merge_blocked",
    next: { command: "operator pr wait" },
    state: { conditions: { reviewEnded: false } },
  });
  expect(await Bun.file(github).json()).not.toHaveProperty("mergeRequests");
  expect((await device.run(["pr", "wait", "--timeout", "0"], options)).output).toMatchObject({
    reason: "pr_wait_timed_out",
    data: { events: [], mergeConditions: { reviewEnded: false } },
  });
  // The fixture declares a supported snapshot guard, without adding custom-kind settings.
  const kind = WorkerKinds.resolve("implementation");
  kind.workPhases[0] = { name: "build", goal: "Build.", guard: "pr_ready" };
  using database = new Database(`${device.root}/state/operator/operator.sqlite`);
  database
    .query("UPDATE pull_requests SET progress = ?")
    .run(JSON.stringify({ seen: [], failures: [], eligibleHead: head }));
  database
    .query("UPDATE launches SET kind = ? WHERE pane_id = ?")
    .run(JSON.stringify(kind), worker.paneId);
  await Bun.write(github, JSON.stringify({ pulls: [{ ...pull, isDraft: true }] }));
  expect((await device.run(["pr", "wait", "--timeout", "0"], options)).output).toMatchObject({
    reason: "pr_wait_timed_out",
  });
  expect((await device.run(["pr", "associate"], options)).output).toMatchObject({
    reason: "pr_not_ready",
    state: { pr_ready: false },
  });
  expect(await Bun.file(github).json()).not.toHaveProperty("mergeRequests");
  database
    .query("UPDATE launches SET kind = ? WHERE pane_id = ?")
    .run(JSON.stringify(WorkerKinds.resolve("implementation")), worker.paneId);
  // Recorded readiness does not replace the final live draft gate.
  await Bun.write(github, JSON.stringify({ pulls: [{ ...pull, isDraft: true }] }));
  expect((await device.run(["pr", "merge"], options)).output).toMatchObject({
    reason: "pr_merge_blocked",
  });
  await Bun.write(github, JSON.stringify({ pulls: [{ ...pull, isDraft: false }] }));
  expect((await device.run(["pr", "associate"], options)).output).toMatchObject({
    reason: "pr_associated",
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    const state = z
      .object({
        data: z.object({
          launches: z.array(
            z.object({
              state: z.string(),
              paneId: z.string().nullable(),
              kind: z.object({ name: z.string() }).nullable(),
            }),
          ),
        }),
      })
      .parse((await device.run(["source", "show", "--source", source])).output);
    const latest = state.data.launches.at(-1);
    if (
      latest?.state === "running" &&
      latest.kind?.name === "pr-feedback" &&
      latest.paneId !== null
    ) {
      options.pane = latest.paneId;
      break;
    }
    expect(Date.now()).toBeLessThan(deadline);
    await Bun.sleep(50);
  }
  expect((await device.exec(["git", "commit", "--allow-empty", "-m", "new head"], cwd)).code).toBe(
    0,
  );
  const localHead = (await device.exec(["git", "rev-parse", "HEAD"], cwd)).stdout.trim();
  expect((await device.run(["pr", "merge"], options)).output).toMatchObject({
    reason: "pr_head_mismatch",
    next: { decider: "super-agent" },
    state: { localHead, prHead: head },
  });
  expect(await Bun.file(github).json()).not.toHaveProperty("mergeRequests");
});

test("prototype results expose the command frontier, not observed reasoning progress", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#383",
    assignments: [
      {
        key: "prototype",
        kind: "prototype",
        trackerKey: "github:example/one#1",
        instructions: "Build then gather a reaction.",
        branch: "task/prototype",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "prototype");
  for (const args of [["--version"], ["ready"]]) {
    const result = await device.run(args, { pane: worker.paneId });
    expect(result.output).toMatchObject({
      kind: "prototype",
      phase: "react",
      next: { command: "operator report submit --file <file>" },
    });
  }
  expect((await device.run(["not-a-command"], { pane: worker.paneId })).output).toMatchObject({
    kind: "prototype",
    phase: "react",
    next: { command: "operator --help" },
  });
});

test("a worker's compact readiness refusal names its kind and phase", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#383",
    assignments: [
      {
        key: "read",
        kind: "research",
        trackerKey: "github:example/one#1",
        instructions: "Read.",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "read");
  await rm(`${device.root}/upstream/code-review/SKILL.md`);
  const result = await device.exec(
    ["env", `HERDR_PANE_ID=${worker.paneId}`, `${device.root}/tools/operator`, "ready"],
    device.main,
  );
  expect(result.code).toBe(3);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("[kind=research phase=investigate]");
  expect(result.stderr).toContain("operator install --opencode");
  expect(result.stderr).toContain("operator install --claude");
  expect(result.stderr.trim().split("\n")).toHaveLength(3);
});

test("plain version and help retain their text and add the worker's next step", async () => {
  device = await workerDevice();
  const source = await device.register({
    trackerKey: "github:example/one#383",
    assignments: [
      {
        key: "read",
        kind: "research",
        trackerKey: "github:example/one#1",
        instructions: "Read.",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "read");
  for (const flag of ["--version", "--help"]) {
    const result = await device.exec(
      ["env", `HERDR_PANE_ID=${worker.paneId}`, `${device.root}/tools/operator`, flag],
      device.main,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith(flag === "--help" ? "Usage: operator" : "operator ")).toBe(
      true,
    );
    expect(result.stdout).toContain("kind: research; phase: investigate\n");
    expect(result.stdout).toContain("next: operator report submit --file <file>\n");
  }
});

test("a typed PR worktree enforces phase guards without a registered caller pane", async () => {
  device = await workerDevice({ github: true });
  const source = await device.register({
    trackerKey: "github:example/one#383",
    assignments: [
      {
        key: "build",
        kind: "implementation",
        trackerKey: "github:example/one#1",
        instructions: "Build.",
        branch: "task/build",
        dependencies: [],
      },
    ],
  });
  const worker = await device.dispatch(source, "build");
  const cwd = worker.worktreePath ?? "";
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      pulls: [
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          headRefName: "task/build",
          head: (await device.exec(["git", "rev-parse", "HEAD"], cwd)).stdout.trim(),
          isDraft: true,
          headRepository: "example/one",
          state: "OPEN",
        },
      ],
    }),
  );
  await Bun.write(`${cwd}/pending.txt`, "uncommitted");
  const refused = await device.run(["pr", "associate"], { cwd });
  expect(refused).toMatchObject({
    code: 3,
    output: {
      reason: "pr_worktree_unclean",
      kind: "implementation",
      phase: "build",
      next: { command: "git status --short" },
      state: { worktree_clean: false },
    },
  });
  expect((await device.run(["source", "show", "--source", source])).output).toMatchObject({
    data: { pullRequests: [] },
  });
  await rm(`${cwd}/pending.txt`);
  expect(await device.run(["pr", "associate"], { cwd })).toMatchObject({
    code: 0,
    output: {
      reason: "pr_associated",
      kind: "implementation",
      phase: "feedback",
      next: { command: "operator pr wait" },
    },
  });
});

test("PR guards and result context follow the canonical worktree owner, not the caller's other pane", async () => {
  device = await workerDevice({ github: true });
  const source = await device.register({
    trackerKey: "github:example/one#383",
    maxRunning: 2,
    assignments: [
      {
        key: "build",
        kind: "implementation",
        trackerKey: "github:example/one#1",
        instructions: "Build.",
        branch: "task/build",
        dependencies: [],
      },
      {
        key: "read",
        kind: "research",
        trackerKey: "github:example/one#2",
        instructions: "Read.",
        dependencies: [],
      },
    ],
  });
  const builder = await device.dispatch(source, "build");
  const reader = await device.dispatch(source, "read");
  expect(
    (
      await device.run(["pr", "round", "--file", "absent.json"], {
        pane: builder.paneId,
        cwd: device.main,
      })
    ).output,
  ).toMatchObject({ reason: "pr_worktree_unrecorded" });
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      pulls: [
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          headRefName: "task/build",
          head: (
            await device.exec(["git", "rev-parse", "HEAD"], builder.worktreePath ?? "")
          ).stdout.trim(),
          isDraft: true,
          headRepository: "example/one",
          state: "OPEN",
        },
      ],
    }),
  );
  const options = { pane: reader.paneId, cwd: builder.worktreePath ?? "" };
  expect((await device.run(["pr", "associate"], options)).output).toMatchObject({
    reason: "pr_associated",
    kind: "implementation",
    phase: "feedback",
    data: { assignment: "build" },
    next: { command: "operator pr wait" },
  });
  expect((await device.run(["pr", "wait", "--timeout", "0"], options)).output).toMatchObject({
    kind: "implementation",
    phase: "feedback",
    data: { assignment: "build" },
  });
  expect((await device.run(["source", "show", "--source", source])).output).toMatchObject({
    data: { reports: [], pullRequests: [{ assignment: "build", number: 7 }] },
  });
});
