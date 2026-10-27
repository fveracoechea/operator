import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
});
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

function plan(profile?: string) {
  const investigate: Record<string, unknown> = {
    key: "investigate",
    trackerKey: "github:example/one#11",
    instructions:
      "Read the module and report the gaps. You may decide naming. Ask the person about scope.",
    completion: "report",
    resources: "pane",
    dependencies: [],
  };
  if (profile !== undefined) investigate.profile = profile;
  return {
    trackerKey: "github:example/one#10",
    assignments: [
      investigate,
      {
        key: "follow",
        trackerKey: "github:example/one#13",
        instructions: "Use the accepted investigation.",
        completion: "report",
        resources: "pane",
        dependencies: ["investigate"],
      },
      {
        key: "implement",
        trackerKey: "github:example/one#12",
        instructions: "Implement the change.",
        completion: "pr",
        resources: "worktree",
        branch: "task/12-implement",
        dependencies: [],
      },
    ],
  };
}

const report = {
  conclusion: "The module has two gaps.",
  evidence: ["modules/a.ts:10 reads no state."],
  unresolved: ["Whether the scope includes b.ts."],
  decisions: [
    { question: "Which name?", answer: "Use reader.", by: "super-agent" },
    { question: "Is b.ts in scope?", answer: "No.", by: "person" },
  ],
};

async function sourceLaunches(source: string) {
  const shown = await device.run(["source", "show", "--source", source]);
  return z
    .object({
      data: z.object({
        launches: z.array(z.looseObject({ assignment: z.string(), state: z.string() })),
        reports: z.array(z.looseObject({ number: z.number() })),
      }),
    })
    .parse(shown.output).data;
}

/** Operator never installs host permission rules for a worker. */
async function permissionFiles() {
  const found: string[] = [];
  for await (const file of new Bun.Glob(
    "**/{settings.json,settings.local.json,opencode.json}",
  ).scan({
    cwd: device.root,
    dot: true,
  }))
    if (!file.includes("node_modules")) found.push(file);
  return found;
}

test.each([
  { host: "opencode", profile: undefined, kind: "opencode" },
  { host: "claude-code", profile: "claude", kind: "claude" },
])(
  "a $host report completes only through SuperAgent acceptance",
  async ({ host, profile }) => {
    const source = await device.register(plan(profile));
    const worker = await device.dispatch(source, "investigate");
    const launched = await device.run(["source", "show", "--source", source]);
    expect(launched.output).toMatchObject({ data: { launches: [{ host }] } });
    const file = await device.writeJson("report.json", report);

    // Host activity is never a submission.
    await device.event("pane.agent_status_changed", {
      pane_id: worker.paneId,
      agent_status: "done",
    });
    expect(await device.next("investigate")).toMatchObject([{ reason: "assignment_active" }]);

    // Only the dispatched pane on its own Herdr server can submit.
    for (const [options, reason] of [
      [{ pane: "other:p9" }, "worker_launch_not_found"],
      [{ pane: worker.paneId, socket: "/elsewhere.sock" }, "worker_launch_not_found"],
    ] as const)
      expect(await device.run(["report", "submit", "--file", file], options)).toMatchObject({
        output: { reason },
      });
    const submitted = await device.run(["report", "submit", "--file", file], {
      pane: worker.paneId,
    });
    expect(submitted.code, submitted.stderr).toBe(0);
    expect(submitted.output).toMatchObject({
      reason: "report_submitted",
      data: { assignment: "investigate", state: "reported", report: 1 },
    });
    const stored = await Bun.file(
      z.object({ data: z.object({ file: z.string() }) }).parse(submitted.output).data.file,
    ).text();
    expect(stored).toContain("## Human answers\n\n- Is b.ts in scope? Answer: No.");
    expect(stored).toContain(
      "## SuperAgent decisions\n\nA SuperAgent decision is not a human answer.\n\n- Which name? Answer: Use reader.",
    );

    // Submission does not unblock the dependent, and the worker cannot submit twice.
    expect(await device.next("investigate")).toMatchObject([
      {
        action: "review_report",
        reason: "report_submitted",
        report: { number: 1, conclusion: report.conclusion },
      },
    ]);
    expect(await device.next("follow")).toMatchObject([
      {
        action: "wait",
        reason: "dependencies_pending",
        blockers: [{ assignment: "investigate", state: "reported" }],
      },
    ]);
    expect(
      await device.run(["report", "submit", "--file", file], { pane: worker.paneId }),
    ).toMatchObject({ code: 3, output: { reason: "report_awaiting_decision" } });

    // The worker cannot accept its own report.
    const database = `${device.root}/state/operator/operator.sqlite`;
    const before = await Bun.file(database).arrayBuffer();
    expect(
      await device.run(["report", "accept", "--source", source, "--assignment", "investigate"], {
        pane: worker.paneId,
      }),
    ).toMatchObject({ code: 4, output: { reason: "self_decision_refused" } });
    expect(await Bun.file(database).arrayBuffer()).toEqual(before);

    const accepted = await device.run([
      "report",
      "accept",
      "--source",
      source,
      "--assignment",
      "investigate",
    ]);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(accepted.output).toMatchObject({
      reason: "report_accepted",
      data: {
        state: "completed",
        report: 1,
        conclusion: report.conclusion,
        reference: `operator:example/one/sources/${source}/assignments/investigate/reports/1`,
        cleanup: { state: "done", detail: `Closed pane ${worker.paneId}.` },
      },
    });
    expect(await device.herdrCalls()).toContain("pane close");
    expect(await device.next("investigate")).toEqual([]);
    expect(await device.next("follow")).toMatchObject([{ action: "ready_assignment" }]);
    // The pane close that acceptance caused is not an interruption.
    expect((await sourceLaunches(source)).launches).toMatchObject([
      { assignment: "investigate", state: "finished" },
    ]);
    expect(await permissionFiles()).toEqual([]);
  },
  60000,
);

test("report commands refuse PR work, undecided states, and missing panes without changes", async () => {
  const source = await device.register(plan());
  const pr = await device.dispatch(source, "implement");
  const file = await device.writeJson("report.json", report);
  const database = `${device.root}/state/operator/operator.sqlite`;
  const before = await Bun.file(database).arrayBuffer();
  expect(await device.run(["report", "submit", "--file", file], { pane: pr.paneId })).toMatchObject(
    { code: 3, output: { reason: "assignment_not_report" } },
  );
  const outside = await device.exec(
    [
      "env",
      "-u",
      "HERDR_PANE_ID",
      process.execPath,
      `${import.meta.dir}/../../cli.ts`,
      "report",
      "submit",
      "--file",
      file,
      "--json",
    ],
    device.main,
  );
  expect(JSON.parse(outside.stdout)).toMatchObject({ reason: "worker_pane_required" });
  for (const command of ["accept", "return"]) {
    const args = ["report", command, "--source", source, "--assignment", "investigate"];
    if (command === "return") args.push("--file", file);
    expect(await device.run(args)).toMatchObject({
      code: 3,
      output: { reason: "report_not_submitted" },
    });
  }
  expect(await device.run(["report", "resume"], { pane: pr.paneId })).toMatchObject({
    code: 3,
    output: { reason: "assignment_not_report" },
  });
  const invalid = await device.writeJson("invalid.json", { conclusion: "x" });
  expect(
    await device.run(["report", "submit", "--file", invalid], { pane: pr.paneId }),
  ).toMatchObject({ code: 2, output: { reason: "invalid_report_input" } });
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);
  expect(
    await Array.fromAsync(new Bun.Glob("**/reports/**").scan({ cwd: `${device.root}/state` })),
  ).toEqual([]);
});

test("returned work resumes, and a replacement keeps reports, follow-up, and current settings", async () => {
  const source = await device.register(plan("careful"));
  const worker = await device.dispatch(source, "investigate");
  await Bun.write(`${device.root}/drafts/notes.md`, "first notes\n", { createPath: true });
  const first = await device.writeJson("first.json", {
    ...report,
    files: [`${device.root}/drafts/notes.md`],
  });
  expect(
    (await device.run(["report", "submit", "--file", first], { pane: worker.paneId })).code,
  ).toBe(0);
  // The stored copy does not follow a later change to the draft.
  await Bun.write(`${device.root}/drafts/notes.md`, "changed notes\n");
  const followUp = `${device.root}/drafts/follow-up.md`;
  await Bun.write(followUp, "Also read b.ts and cite it.\n");
  const returned = await device.run([
    "report",
    "return",
    "--source",
    source,
    "--assignment",
    "investigate",
    "--file",
    followUp,
  ]);
  expect(returned.code, returned.stderr).toBe(0);
  expect(returned.output).toMatchObject({
    reason: "report_returned",
    data: { report: 1, next: "resume_worker" },
  });
  expect(await device.next("investigate")).toMatchObject([
    { action: "resume_worker", reason: "follow_up_returned", report: { decision: "returned" } },
  ]);
  // A live worker resumes. A dispatch cannot start a second worker for it.
  expect(
    await device.run(["dispatch", "--source", source, "--assignment", "investigate"]),
  ).toMatchObject({ code: 4, output: { reason: "assignment_not_dispatchable" } });
  const resumed = await device.run(["report", "resume"], { pane: worker.paneId });
  expect(resumed.output).toMatchObject({
    reason: "report_resumed",
    data: { state: "running", followUp: expect.stringMatching(/follow-ups\/1\.md$/) as unknown },
  });
  expect(await device.next("investigate")).toMatchObject([{ reason: "assignment_active" }]);

  // The second report is submitted, then the pane ends before the SuperAgent decides.
  const second = await device.writeJson("second.json", { ...report, conclusion: "b.ts is fine." });
  expect(
    (await device.run(["report", "submit", "--file", second], { pane: worker.paneId })).code,
  ).toBe(0);
  await device.exec(["herdr", "pane", "exit", worker.paneId, "w1"], device.main);
  expect(await device.next("investigate")).toMatchObject([
    { action: "review_report", report: { number: 2 } },
  ]);
  await Bun.write(followUp, "Add the test evidence.\n");
  expect(
    await device.run([
      "report",
      "return",
      "--source",
      source,
      "--assignment",
      "investigate",
      "--file",
      followUp,
    ]),
  ).toMatchObject({ code: 0, output: { data: { report: 2, next: "replace_worker" } } });
  expect(await device.next("investigate")).toMatchObject([
    { action: "replace_worker", reason: "worker_interrupted" },
  ]);

  // The replacement uses current settings and reads every earlier report and follow-up.
  await Bun.write(
    `${device.root}/config/operator/config.json`,
    JSON.stringify({
      superAgent: { host: "opencode", model: "test/reasoner" },
      profiles: { careful: { model: "test/writer", reasoningEffort: "medium" } },
    }),
  );
  const replacement = await device.dispatch(source, "investigate");
  expect(replacement.attempt).toBe(2);
  const brief = await Bun.file(replacement.brief).text();
  expect(brief).toContain("Read the module and report the gaps.");
  for (const file of ["1/report.md", "1/files/notes.md", "2/report.md"])
    expect(brief).toContain(`/reports/${file}\``);
  for (const file of ["1.md", "2.md"]) expect(brief).toContain(`/follow-ups/${file}\``);
  const directory = brief.match(/`([^`]+\/reports)\/1\/files\/notes\.md`/)?.[1] ?? "";
  expect(await Bun.file(`${directory}/1/files/notes.md`).text()).toBe("first notes\n");
  expect(await device.next("investigate")).toMatchObject([{ reason: "assignment_active" }]);
  const history = await sourceLaunches(source);
  expect(history.launches).toMatchObject([
    { state: "interrupted", model: "test/reasoner", reasoningEffort: "high" },
    { state: "running", model: "test/writer", reasoningEffort: "medium" },
  ]);
  expect(history.reports).toMatchObject([
    { number: 1, decision: "returned", followUp: "Also read b.ts and cite it." },
    { number: 2, decision: "returned", followUp: "Add the test evidence." },
  ]);
}, 60000);

test("acceptance keeps a worktree with unlanded work, and failed cleanup stays in next", async () => {
  const source = await device.register({
    trackerKey: "github:example/one#20",
    assignments: ["prototype", "probe"].map((key, index) => ({
      key,
      trackerKey: `github:example/one#${21 + index}`,
      instructions: `Build the ${key} in the worktree and report.`,
      completion: "report",
      resources: "worktree",
      branch: `task/${key}`,
      dependencies: [],
    })),
  });
  const file = await device.writeJson("report.json", report);
  function git(cwd: string, ...args: string[]) {
    return device.exec(["git", ...args], cwd);
  }

  // An untracked prototype file is unlanded work.
  const prototype = await device.dispatch(source, "prototype");
  const kept = prototype.worktreePath ?? "";
  await Bun.write(`${kept}/prototype.ts`, "export {};\n");
  await device.run(["report", "submit", "--file", file], { pane: prototype.paneId });
  const accepted = await device.run([
    "report",
    "accept",
    "--source",
    source,
    "--assignment",
    "prototype",
  ]);
  expect(accepted.output).toMatchObject({
    data: {
      cleanup: {
        state: "done",
        detail: expect.stringContaining(
          "because it holds changed or untracked prototype.ts",
        ) as unknown,
      },
    },
  });
  expect(await Bun.file(`${kept}/prototype.ts`).exists()).toBe(true);
  expect((await git(device.main, "rev-parse", "--verify", "task/prototype")).code).toBe(0);

  // A failed pane closure stays visible after the source ends, and a repeated accept retries it.
  const probe = await device.dispatch(source, "probe");
  const clean = probe.worktreePath ?? "";
  await device.run(["report", "submit", "--file", file], { pane: probe.paneId });
  // Another Herdr server can reuse the pane id, so that server closes nothing.
  const closes = (await device.herdrCalls()).filter((call) => call === "pane close").length;
  const elsewhere = await device.run(
    ["report", "accept", "--source", source, "--assignment", "probe"],
    { socket: "/elsewhere.sock" },
  );
  expect(elsewhere.output).toMatchObject({
    reason: "report_accepted",
    data: {
      sourceFinished: true,
      cleanup: {
        state: "failed",
        detail: expect.stringContaining("another Herdr server") as unknown,
      },
    },
  });
  expect((await device.herdrCalls()).filter((call) => call === "pane close")).toHaveLength(closes);
  await device.setHerdr({ fail: { "pane close": "herdr is restarting" } });
  const failed = await device.run([
    "report",
    "accept",
    "--source",
    source,
    "--assignment",
    "probe",
  ]);
  expect(failed.output).toMatchObject({
    reason: "report_cleanup_retried",
    data: {
      cleanup: { state: "failed", detail: expect.stringContaining("restarting") as unknown },
    },
  });
  expect(await device.next("probe")).toMatchObject([
    { action: "retry_cleanup", reason: "cleanup_failed" },
  ]);
  expect(await Bun.file(`${clean}/.env.local`).exists()).toBe(true);
  await device.setHerdr({ fail: {} });
  const retried = await device.run([
    "report",
    "accept",
    "--source",
    source,
    "--assignment",
    "probe",
  ]);
  expect(retried.output).toMatchObject({
    reason: "report_cleanup_retried",
    data: {
      cleanup: {
        state: "done",
        detail: expect.stringContaining(
          `Removed worktree ${clean} and its branch task/probe`,
        ) as unknown,
      },
    },
  });
  expect(await Bun.file(`${clean}/package.json`).exists()).toBe(false);
  expect((await git(device.main, "rev-parse", "--verify", "task/probe")).code).not.toBe(0);
  expect(await device.next("probe")).toEqual([]);
  expect(await Bun.file(`${kept}/prototype.ts`).exists()).toBe(true);
}, 60000);

test("a consumer brief keeps accepted content after the producer project is removed", async () => {
  const producer = await device.register({
    trackerKey: "github:example/one#30",
    assignments: [plan().assignments[0]],
  });
  const worker = await device.dispatch(producer, "investigate");
  const file = await device.writeJson("report.json", report);
  await device.run(["report", "submit", "--file", file], { pane: worker.paneId });
  const accepted = z
    .object({ data: z.object({ conclusion: z.string(), reference: z.string(), file: z.string() }) })
    .parse(
      (await device.run(["report", "accept", "--source", producer, "--assignment", "investigate"]))
        .output,
    ).data;

  // The consumer SuperAgent copies the content it needs, with its reference, into the plan.
  const consumer = await device.checkout("two", "example/two");
  expect((await device.run(["project", "register"], { cwd: consumer })).code).toBe(0);
  const source = await device.register(
    {
      trackerKey: "github:example/two#1",
      assignments: [
        {
          key: "apply",
          trackerKey: "github:example/two#2",
          instructions: `Apply this accepted finding from ${accepted.reference}: ${accepted.conclusion}`,
          completion: "report",
          resources: "pane",
          dependencies: [],
        },
      ],
    },
    consumer,
  );
  const launched = await device.dispatch(source, "apply", consumer);
  expect(
    (
      await device.run(["project", "remove", "example/one", "--person-instructed"], {
        cwd: consumer,
      })
    ).code,
  ).toBe(0);
  expect(await Bun.file(accepted.file).exists()).toBe(false);
  const brief = await Bun.file(launched.brief).text();
  expect(brief).toContain(accepted.reference);
  expect(brief).toContain(accepted.conclusion);
  expect(await device.run(["source", "show", "--source", source], { cwd: consumer })).toMatchObject(
    {
      output: {
        data: {
          plan: {
            assignments: [
              { instructions: expect.stringContaining(accepted.conclusion) as unknown },
            ],
          },
        },
      },
    },
  );
}, 60000);

test("a refused concurrent submission or return leaves the recorded files unchanged", async () => {
  const source = await device.register(plan());
  const worker = await device.dispatch(source, "investigate");
  const files = await Promise.all(
    ["a", "b"].map((name) => device.writeJson(`${name}.json`, { ...report, conclusion: name })),
  );
  const submitted = await Promise.all(
    files.map((file) => device.run(["report", "submit", "--file", file], { pane: worker.paneId })),
  );
  // The loser reads the winner's record, or loses the write transaction.
  expect(submitted.filter((row) => row.code === 0)).toHaveLength(1);
  expect(submitted.find((row) => row.code !== 0)?.output.reason).toBeOneOf([
    "report_awaiting_decision",
    "report_changed",
  ]);
  const winner = submitted.find((row) => row.code === 0)?.output;
  const stored = z.object({ data: z.object({ file: z.string() }) }).parse(winner).data.file;
  const shown = await sourceLaunches(source);
  expect(shown.reports).toHaveLength(1);
  const conclusion = z.object({ conclusion: z.string() }).parse(shown.reports[0]).conclusion;
  expect(await Bun.file(stored).text()).toContain(`## Conclusion\n\n${conclusion}\n`);

  const notes = await Promise.all(
    ["first", "second"].map(async (text) => {
      const file = `${device.root}/drafts/${text}.md`;
      await Bun.write(file, `${text} follow-up\n`, { createPath: true });
      return file;
    }),
  );
  const returned = await Promise.all(
    notes.map((file) =>
      device.run([
        "report",
        "return",
        "--source",
        source,
        "--assignment",
        "investigate",
        "--file",
        file,
      ]),
    ),
  );
  expect(returned.filter((row) => row.code === 0)).toHaveLength(1);
  expect(returned.find((row) => row.code !== 0)?.output.reason).toBeOneOf([
    "report_not_submitted",
    "report_changed",
  ]);
  const followUp = z
    .object({ data: z.object({ followUp: z.string() }) })
    .parse(returned.find((row) => row.code === 0)?.output).data.followUp;
  const recorded = z
    .object({ followUp: z.string() })
    .parse((await sourceLaunches(source)).reports[0]).followUp;
  expect(await Bun.file(followUp).text()).toBe(`${recorded}\n`);
  expect(
    await Array.fromAsync(new Bun.Glob("**/pending/**").scan({ cwd: `${device.root}/state` })),
  ).toEqual([]);
}, 60000);
