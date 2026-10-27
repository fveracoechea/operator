import { afterEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

type Device = Awaited<ReturnType<typeof workerDevice>>;
let device: Device | undefined;

let argv: string[][] = [];

afterEach(async () => {
  if (device !== undefined) await rm(device.root, { recursive: true, force: true });
  device = undefined;
  argv = [];
});

/** Each workflow command of the SuperAgent and the WorkerAgents, with its real arguments. */
function cli(args: string[], options: { cwd?: string; pane?: string } = {}) {
  argv.push(args);
  return (device as Device).run(args, options);
}

/** One report and two dependent PRs, with the delegated authority stated in the instructions. */
function plan(profile: string | undefined) {
  const authority = "You may decide naming and test layout. Ask the person about scope.";
  function pr(key: string, number: number): Record<string, unknown> {
    return {
      key,
      trackerKey: `github:example/one#${number}`,
      instructions: `Implement ${key}. ${authority}`,
      completion: "pr",
      resources: "worktree",
      branch: `task/${number}-${key}`,
      dependencies: ["research"],
    };
  }
  const assignments: Record<string, unknown>[] = [
    {
      key: "research",
      trackerKey: "github:example/one#31",
      instructions: `Read the module and report the approach. ${authority}`,
      completion: "report",
      resources: "pane",
      dependencies: [],
    },
    pr("implement", 32),
    pr("document", 33),
  ];
  if (profile !== undefined) for (const assignment of assignments) assignment.profile = profile;
  return { trackerKey: "github:example/one#30", assignments };
}

const rowSchema = z.looseObject({
  action: z.string(),
  reason: z.string().optional(),
  assignment: z.string().optional(),
});

async function rows(source: string) {
  const read = await (device as Device).run(["next", "--source", source]);
  expect(read.code, read.stderr).toBe(0);
  return z
    .object({
      data: z.object({
        sources: z.tuple([
          z.object({ state: z.string(), actions: z.array(rowSchema), waits: z.array(rowSchema) }),
        ]),
      }),
    })
    .parse(read.output).data.sources[0];
}

async function git(cwd: string, ...args: string[]) {
  const result = await (device as Device).exec(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

type Pull = Record<string, unknown> & { number: number };
async function github(
  change: (state: { pulls: Pull[]; branches: Record<string, string> }) => void,
) {
  const file = Bun.file(`${(device as Device).root}/github.json`);
  const state = (await file.exists())
    ? z
        .object({
          pulls: z.array(z.looseObject({ number: z.number() })),
          branches: z.record(z.string(), z.string()),
        })
        .loose()
        .parse(await file.json())
    : { pulls: [], branches: {} };
  change(state);
  await Bun.write(file, JSON.stringify(state));
}

const resultSchema = z.object({ reason: z.string(), data: z.looseObject({}).optional() });

/** The worker's public commands. The test plays the reviewer and CI on the controlled GitHub. */
async function workPullRequest(key: string, worktree: string, options: { leaveNotes: boolean }) {
  function run(args: string[]) {
    return cli(args, { cwd: worktree });
  }
  const number = key === "implement" ? 7 : 8;
  const branch = await git(worktree, "branch", "--show-current");
  await Bun.write(`${worktree}/${key}.txt`, `${key}\n`);
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", key);
  const first = await git(worktree, "rev-parse", "HEAD");
  await github((state) => {
    state.pulls.push({
      number,
      url: `https://github.com/example/one/pull/${number}`,
      headRefName: branch,
      headRepository: "example/one",
      state: "OPEN",
      head: first,
      reviewDecision: "CHANGES_REQUESTED",
      threads: [{ path: `${key}.txt`, comments: [{ id: `T${number}`, body: "Add a line." }] }],
      checks: [{ name: "ci", conclusion: "SUCCESS" }],
    });
    state.branches[branch] = first;
  });
  expect(await run(["pr", "associate"])).toMatchObject({ code: 0 });

  // The first round brings review feedback. The owner fixes it and pushes to the same PR.
  const feedback = resultSchema.parse((await run(["pr", "wait", "--timeout", "0"])).output);
  expect(feedback).toMatchObject({
    reason: "pr_events_observed",
    data: { events: [{ kind: "feedback" }] },
  });
  await Bun.write(`${worktree}/${key}.txt`, `${key}\nfixed\n`);
  await git(worktree, "commit", "-q", "-am", "fix");
  const fixed = await git(worktree, "rev-parse", "HEAD");
  await github((state) => {
    const pull = state.pulls.find((row) => row.number === number) as Pull;
    Object.assign(pull, {
      head: fixed,
      reviewDecision: "APPROVED",
      reviews: [{ id: `R${number}`, state: "APPROVED", body: "" }],
      threads: [
        {
          path: `${key}.txt`,
          resolved: true,
          comments: [{ id: `T${number}`, body: "Add a line." }],
        },
      ],
    });
    state.branches[branch] = fixed;
  });
  const eligible = resultSchema.parse((await run(["pr", "wait", "--timeout", "0"])).output);
  expect(eligible.data?.events).toContainEqual(expect.objectContaining({ kind: "merge_eligible" }));
  if (options.leaveNotes) await Bun.write(`${worktree}/notes.txt`, "unlanded\n");
  expect(await run(["pr", "merge"])).toMatchObject({ code: 0, output: { reason: "pr_merged" } });
}

const report = {
  conclusion: "Split the reader from the writer.",
  evidence: ["modules/a.ts:10 mixes reads and writes."],
  unresolved: ["Whether the writer needs a retry."],
  decisions: [{ question: "Which name?", answer: "Use reader.", by: "super-agent" }],
};

type Stop = { assignment: string | undefined; reason: string | undefined };

/**
 * The SuperAgent follows only `next`. Each routine action runs without a person, and each WorkerAgent
 * does its work right after dispatch. A `person_decision` is a human stop: the loop records it and
 * returns, so that the person can answer before the run resumes from durable state.
 * `interrupt` closes that worker's pane once before it submits.
 */
async function supervise(
  source: string,
  options: { interrupt?: string; leaveNotes?: string } = {},
) {
  const d = device as Device;
  const commands: string[][] = [];
  const stops: Stop[] = [];
  const briefs: string[] = [];
  let interrupt = options.interrupt;
  const deadline = Date.now() + 60000;
  for (;;) {
    expect(Date.now()).toBeLessThan(deadline);
    const current = await rows(source);
    const human = current.actions.filter((row) => row.action === "person_decision");
    if (human.length > 0) {
      stops.push(...human.map((row) => ({ assignment: row.assignment, reason: row.reason })));
      return { commands, stops, briefs, state: current.state };
    }
    const routine = current.actions.filter((row) => row.action !== "source_ended");
    if (routine.length === 0) {
      if (current.state !== "open") return { commands, stops, briefs, state: current.state };
      // Only waits remain, for example a cleanup process that still runs.
      await Bun.sleep(100);
      continue;
    }
    for (const row of routine) {
      expect(row.action).toBeOneOf([
        "ready_assignment",
        "replace_worker",
        "review_report",
        "retry_cleanup",
      ]);
      const key = row.assignment ?? "";
      if (row.action === "ready_assignment" || row.action === "replace_worker") {
        commands.push(["dispatch", key]);
        // The fixture runs exactly these arguments.
        argv.push(["dispatch", "--source", source, "--assignment", key]);
        const worker = await d.dispatch(source, key);
        briefs.push(await Bun.file(worker.brief).text());
        if (interrupt === key) {
          interrupt = undefined;
          await d.exec(["herdr", "pane", "exit", worker.paneId, "w1"], d.main);
        } else if (worker.worktreePath === null) {
          const file = await d.writeJson(`${key}.json`, report);
          const submitted = await cli(["report", "submit", "--file", file], {
            pane: worker.paneId,
          });
          expect(submitted.code, submitted.stderr).toBe(0);
        } else
          await workPullRequest(key, worker.worktreePath, {
            leaveNotes: options.leaveNotes === key,
          });
      } else if (row.action === "review_report") {
        commands.push(["report", "accept", key]);
        const accepted = await cli(["report", "accept", "--source", source, "--assignment", key]);
        expect(accepted.code, accepted.stderr).toBe(0);
      } else {
        commands.push(["cleanup", key]);
        const retried = await cli(["cleanup", "--source", source, "--assignment", key]);
        expect(
          retried.code,
          `cleanup ${key}: ${JSON.stringify(retried.output)} ${retried.stderr}`,
        ).toBeOneOf([0, 3]);
      }
    }
  }
}

async function settled(source: string) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const current = await rows(source);
    if (!current.waits.some((row) => row.reason === "cleanup_running")) return current;
    expect(Date.now()).toBeLessThan(deadline);
    await Bun.sleep(100);
  }
}

async function shown(source: string) {
  const result = await (device as Device).run(["source", "show", "--source", source]);
  return z
    .object({
      data: z.looseObject({
        state: z.string(),
        assignments: z.array(z.looseObject({ key: z.string(), state: z.string() })),
        launches: z.array(z.looseObject({ assignment: z.string(), host: z.string() })),
      }),
    })
    .parse(result.output).data;
}

for (const { host, profile } of [
  { host: "opencode", profile: undefined },
  { host: "claude-code", profile: "claude" },
])
  test(`${host}: a delegated report and two reviewed PRs finish with no human stop`, async () => {
    device = await workerDevice({ github: true });
    // Readiness is the only setup check before delegated work. It asks for no approval.
    expect(await device.run(["ready"])).toMatchObject({ code: 0, output: { reason: "ready" } });
    const source = await device.register(plan(profile));

    const run = await supervise(source, { interrupt: "research" });
    expect(run.stops).toEqual([]);
    expect(run.state).toBe("finished");
    // An interrupted worker is replaced as a routine action, not a question for the person.
    expect(run.commands).toEqual([
      ["dispatch", "research"],
      ["dispatch", "research"],
      ["report", "accept", "research"],
      ["dispatch", "implement"],
      ["dispatch", "document"],
    ]);
    // No SuperAgent or WorkerAgent command needed a person flag or a grant.
    expect(argv).toContainEqual(["pr", "merge"]);
    expect(argv.flat()).not.toContain("--person-instructed");
    // Each brief gives the worker the same authority for its routine steps.
    for (const brief of run.briefs)
      expect(brief).toContain("without asking for approval of each command or step");
    // Both PR briefs carry the accepted report's unresolved point.
    expect(run.briefs.filter((brief) => brief.includes(report.unresolved[0] ?? ""))).toHaveLength(
      2,
    );
    const state = await shown(source);
    expect(state.assignments).toMatchObject([
      { key: "research", state: "completed" },
      { key: "implement", state: "merged" },
      { key: "document", state: "merged" },
    ]);
    expect(new Set(state.launches.map((launch) => launch.host))).toEqual(new Set([host]));
    expect((await settled(source)).actions).toMatchObject([{ action: "source_ended" }]);
  }, 120000);

test("unlanded work is the one human stop, and the run resumes at the recorded cleanup step", async () => {
  device = await workerDevice({ github: true });
  const source = await device.register(plan(undefined));

  const first = await supervise(source, { leaveNotes: "implement" });
  expect(first.stops).toEqual([{ assignment: "implement", reason: "cleanup_unlanded_work" }]);
  // Both PRs merged, so the source finished. Its open cleanup still waits for the person.
  expect(first.state).toBe("finished");
  // The other PR's cleanup can still run when the stop shows.
  await settled(source);
  const closes = (await device.herdrCalls()).filter((call) => call === "pane close").length;

  // Without the person's instruction the SuperAgent cannot pass the stop.
  expect(
    await device.run(["cleanup", "--source", source, "--assignment", "implement"]),
  ).toMatchObject({ code: 3, output: { reason: "cleanup_unlanded_work" } });

  // The person instructs the deletion. Cleanup continues at the worktree step.
  const instructed = await device.run([
    "cleanup",
    "--source",
    source,
    "--assignment",
    "implement",
    "--person-instructed",
  ]);
  expect(instructed).toMatchObject({ code: 0 });
  const resumed = await supervise(source);
  expect(resumed.stops).toEqual([]);
  expect(resumed.commands).toEqual([]);
  expect(resumed.state).toBe("finished");
  // The resume repeated no merge, pane close, or dispatch.
  expect((await device.herdrCalls()).filter((call) => call === "pane close").length).toBe(closes);
  const merges = (await Bun.file(`${device.root}/gh-calls.jsonl`).text())
    .split("\n")
    .filter((line) => line.includes('"PUT"'));
  expect(merges).toHaveLength(2);
}, 120000);
