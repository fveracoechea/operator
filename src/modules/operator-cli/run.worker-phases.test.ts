import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";

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
      "--file",
      await device.writeJson("question.json", { key: "scope", question: "Which scope?" }),
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
      await device.writeJson("report.json", {
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
    ["report", "submit", "--file", `${device.root}/drafts/report.json`],
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
    (await device.run(["report", "submit", "--file", `${device.root}/drafts/report.json`], options))
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
        },
      ],
    }),
  );
  await Bun.write(`${cwd}/pending.txt`, "not committed");
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
    reason: "pr_not_ready",
    next: { command: "operator pr wait" },
    state: { pr_ready: false },
  });
  const head = (await device.exec(["git", "rev-parse", "HEAD"], cwd)).stdout.trim();
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
    reason: "pr_not_ready",
    state: { pr_ready: false },
  });
  await Bun.write(github, JSON.stringify({ pulls: [{ ...pull, isDraft: false }] }));
  expect((await device.run(["pr", "wait", "--timeout", "0"], options)).output).toMatchObject({
    reason: "pr_events_observed",
    data: { events: [{ kind: "merge_eligible", head }] },
  });
  // Recorded readiness does not replace the final live draft gate.
  await Bun.write(github, JSON.stringify({ pulls: [{ ...pull, isDraft: true }] }));
  expect((await device.run(["pr", "merge"], options)).output).toMatchObject({
    reason: "pr_merge_blocked",
  });
  expect((await device.exec(["git", "commit", "--allow-empty", "-m", "new head"], cwd)).code).toBe(
    0,
  );
  expect((await device.run(["pr", "merge"], options)).output).toMatchObject({
    reason: "pr_not_ready",
    next: { command: "operator pr wait" },
    state: { pr_ready: false },
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
