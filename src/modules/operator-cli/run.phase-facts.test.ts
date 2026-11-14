import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { Err, Ok, OkAsync } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
import { ReportAssignments } from "../report-assignments/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { OperatorCli } from "./main.ts";
import { workerDevice } from "./worker-fixture.ts";

type Source = Extract<ReturnType<typeof DeviceState.readSources>, { tag: "Ok" }>["value"][number];
type PaneFacts = Extract<ReturnType<typeof DeviceState.readReport>, { tag: "Ok" }>["value"];
type Invocation = Awaited<ReturnType<typeof ToolInvocation.run>>;
let device: Awaited<ReturnType<typeof workerDevice>>;
let paths: ReturnType<typeof OperatorHome.resolve>;
let saved: Source;
let pane: PaneFacts;
let reportPane: string;
let prPane: string;
let source: Source;
let current: PaneFacts;
let status: Invocation;
let head: Invocation;
let actorPane: string;
let log: ReturnType<typeof spyOn<typeof console, "log">>;

function required<T>(value: T | null | undefined): T {
  return value ?? expect.unreachable("The isolated fixture record must exist.");
}

beforeAll(async () => {
  device = await workerDevice({ github: true });
  const id = await device.register({
    trackerKey: "github:example/one#383",
    maxRunning: 4,
    assignments: [
      { key: "report", kind: "research", trackerKey: "r", instructions: "Read.", dependencies: [] },
      {
        key: "other-report",
        kind: "answer",
        trackerKey: "or",
        instructions: "Answer.",
        dependencies: [],
      },
      {
        key: "pr",
        kind: "implementation",
        trackerKey: "p",
        instructions: "Build.",
        branch: "task/pr",
        dependencies: [],
      },
      {
        key: "other-pr",
        kind: "implementation",
        trackerKey: "op",
        instructions: "Build another.",
        branch: "task/other",
        dependencies: [],
      },
    ],
  });
  const report = await device.dispatch(id, "report");
  const other = await device.dispatch(id, "other-report");
  const pr = await device.dispatch(id, "pr");
  const otherPr = await device.dispatch(id, "other-pr");
  reportPane = report.paneId;
  prPane = pr.paneId;
  const file = await device.writeJson("report.json", {
    conclusion: "Done.",
    evidence: ["Read."],
    unresolved: [],
    decisions: [],
    files: [],
  });
  for (const worker of [report, other])
    expect(
      (await device.run(["report", "submit", "--file", file], { pane: worker.paneId })).code,
    ).toBe(0);
  expect(
    (await device.run(["report", "accept", "--source", id, "--assignment", "other-report"])).code,
  ).toBe(0);
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      pulls: [
        {
          number: 7,
          url: "https://github.com/example/one/pull/7",
          headRefName: "task/pr",
          headRepository: "example/one",
          state: "OPEN",
        },
        {
          number: 8,
          url: "https://github.com/example/one/pull/8",
          headRefName: "task/other",
          headRepository: "example/one",
          state: "OPEN",
        },
      ],
    }),
  );
  for (const worker of [pr, otherPr])
    expect(
      (
        await device.run(["pr", "associate"], {
          pane: worker.paneId,
          cwd: worker.worktreePath ?? "",
        })
      ).code,
    ).toBe(0);
  paths = OperatorHome.resolve(
    Environment.parse({
      HOME: `${device.root}/home`,
      XDG_CONFIG_HOME: `${device.root}/config`,
      XDG_STATE_HOME: `${device.root}/state`,
      NODE_ENV: "test",
    }),
  );
  const read = DeviceState.readSources(paths, "example/one", id);
  expect(read.tag).toBe("Ok");
  if (read.tag !== "Ok") return;
  saved = required(read.value[0]);
  const facts = DeviceState.readReport(paths, {
    by: "pane",
    socket: `${device.root}/herdr.sock`,
    paneId: reportPane,
  });
  expect(facts.tag).toBe("Ok");
  if (facts.tag === "Ok") pane = facts.value;
});

afterAll(async () => {
  await rm(device.root, { recursive: true, force: true });
});
afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});
beforeEach(() => {
  source = structuredClone(saved);
  current = structuredClone(pane);
  actorPane = reportPane;
  status = { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  head = { status: "completed", exitCode: 0, stdout: "head\n", stderr: "" };
  spyOn(Environment, "read").mockImplementation(() =>
    Environment.parse({
      HOME: `${device.root}/home`,
      XDG_CONFIG_HOME: `${device.root}/config`,
      XDG_STATE_HOME: `${device.root}/state`,
      NODE_ENV: "test",
      HERDR_SOCKET_PATH: `${device.root}/herdr.sock`,
      HERDR_PANE_ID: actorPane,
    }),
  );
  spyOn(DeviceState, "readReport").mockImplementation(() => Ok(current));
  spyOn(DeviceState, "readSources").mockImplementation(() => Ok([source]));
  spyOn(ToolInvocation, "run").mockImplementation(async (input) =>
    input.args[0] === "status" ? status : head,
  );
  spyOn(PullRequests, "workerTarget").mockImplementation(() => {
    const launch = required(
      source.launches.findLast((row) => row.assignment === "pr" && row.state === "running"),
    );
    return OkAsync({
      repository: "example/one",
      sourceId: source.source.id,
      assignment: "pr",
      launchId: launch.id,
    });
  });
  log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

async function run(args = ["--version"]) {
  await OperatorCli.main([...args, "--json"]);
  return z
    .looseObject({
      kind: z.string().optional(),
      phase: z.string().optional(),
      reason: z.string(),
      operation: z.string(),
      next: z
        .looseObject({ command: z.string().optional(), why: z.string().optional() })
        .optional(),
      state: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(JSON.parse(String(log.mock.lastCall?.[0])));
}

function prActor() {
  actorPane = prPane;
  const launch = required(source.launches.find((row) => row.assignment === "pr"));
  current = {
    ...current,
    assignment: required(source.assignments.find((row) => row.key === "pr")),
    launch,
  };
}

test("legacy pane and worktree snapshots keep the untyped command path", async () => {
  required(current.launch).kind = null;
  expect(await run()).not.toHaveProperty("kind");
  current = structuredClone(pane);
  required(source.launches.find((row) => row.assignment === "pr")).kind = null;
  spyOn(PullRequests, "wait").mockReturnValue(
    OkAsync({ reason: "pr_wait_timed_out", data: {} }) as never,
  );
  expect(await run(["pr", "wait", "--timeout", "0"])).not.toHaveProperty("kind");
});

test("a missing pane launch leaves ordinary reads untyped", async () => {
  current.launch = null;
  expect(await run()).not.toHaveProperty("kind");
});

test.each(["socket", "pane"] as const)(
  "an absent worker %s leaves ordinary reads untyped",
  async (missing) => {
    spyOn(Environment, "read").mockReturnValue(
      Environment.parse({
        HOME: `${device.root}/home`,
        XDG_CONFIG_HOME: `${device.root}/config`,
        XDG_STATE_HOME: `${device.root}/state`,
        NODE_ENV: "test",
        HERDR_SOCKET_PATH: missing === "socket" ? undefined : `${device.root}/herdr.sock`,
        HERDR_PANE_ID: missing === "pane" ? undefined : reportPane,
      }),
    );
    expect(await run()).not.toHaveProperty("kind");
  },
);

test.each(["read-error", "empty-source", "missing-launch"] as const)(
  "canonical metadata %s leaves ownership handling with the PR operation",
  async (failure) => {
    const wait = spyOn(PullRequests, "wait").mockReturnValue(
      OkAsync({ reason: "pr_wait_timed_out", data: {} }) as never,
    );
    if (failure === "read-error")
      spyOn(DeviceState, "readSources").mockReturnValue(
        Err({ reason: "state_busy", detail: "Busy." }) as never,
      );
    if (failure === "empty-source") spyOn(DeviceState, "readSources").mockReturnValue(Ok([]));
    if (failure === "missing-launch") {
      const target = required(source.launches.find((row) => row.assignment === "pr"));
      spyOn(PullRequests, "workerTarget").mockReturnValue(
        OkAsync({
          repository: "example/one",
          sourceId: source.source.id,
          assignment: "pr",
          launchId: target.id + "-gone",
        }),
      );
    }
    expect(await run(["pr", "wait", "--timeout", "0"])).not.toHaveProperty("kind");
    expect(wait).toHaveBeenCalledTimes(1);
  },
);

test.each(["read-error", "empty-source"] as const)(
  "an unavailable phase snapshot (%s) does not break ordinary version output",
  async (failure) => {
    if (failure === "read-error")
      spyOn(DeviceState, "readSources").mockReturnValue(
        Err({ reason: "state_busy", detail: "Busy." }) as never,
      );
    else spyOn(DeviceState, "readSources").mockReturnValue(Ok([]));
    expect(await run()).not.toHaveProperty("kind");
  },
);

test("report metadata selects this assignment's receipt and accepted state", async () => {
  const own = required(source.reports.find((row) => row.assignment === "report"));
  const other = required(source.reports.find((row) => row.assignment === "other-report"));
  source.reports = [own, other];
  expect(await run()).toMatchObject({ phase: "acceptance" });
  own.decision = "accepted";
  expect(await run()).toMatchObject({ phase: "complete" });
});

test("PR metadata ignores another assignment's association", async () => {
  prActor();
  source.pullRequests = source.pullRequests.filter((row) => row.assignment === "other-pr");
  expect(await run()).toMatchObject({ phase: "build", next: { command: "operator pr associate" } });
});

test.each(["unavailable", "no-answer", "failed"] as const)(
  "a %s Git status cannot prove a clean phase exit",
  async (failure) => {
    status =
      failure === "failed"
        ? { status: "completed", exitCode: 1, stdout: "", stderr: "failed" }
        : failure === "unavailable"
          ? { status: "unavailable", tool: "git", detail: "missing" }
          : { status: "no-answer", detail: "timeout" };
    const associate = spyOn(PullRequests, "associate").mockReturnValue(
      OkAsync({ reason: "pr_unchanged", data: {} }) as never,
    );
    expect(await run(["pr", "associate"])).toMatchObject({
      operation: "pr_associate",
      reason: "pr_worktree_unclean",
      state: { worktree_clean: false },
    });
    expect(associate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(4);
  },
);

test.each(["unavailable", "no-answer", "failed"] as const)(
  "a %s local head cannot prove readiness",
  async (failure) => {
    required(source.pullRequests.find((row) => row.assignment === "pr")).progress = JSON.stringify({
      seen: [],
      failures: [],
      eligibleHead: "head",
    });
    head =
      failure === "failed"
        ? { status: "completed", exitCode: 1, stdout: "head", stderr: "failed" }
        : failure === "unavailable"
          ? { status: "unavailable", tool: "git", detail: "missing" }
          : { status: "no-answer", detail: "timeout" };
    const merge = spyOn(PullRequests, "merge").mockReturnValue(
      OkAsync({ reason: "pr_merged", data: {} }) as never,
    );
    expect(await run(["pr", "merge"])).toMatchObject({
      reason: "pr_not_ready",
      state: { pr_ready: false },
    });
    expect(merge).not.toHaveBeenCalled();
  },
);

test.each(["unavailable", "no-answer"] as const)(
  "an unfinished %s result cannot reuse an exit code or stale output",
  async (failure) => {
    const stale =
      failure === "unavailable"
        ? {
            status: "unavailable" as const,
            tool: "git",
            detail: "missing",
            exitCode: 0,
            stdout: "",
            stderr: "",
          }
        : {
            status: "no-answer" as const,
            detail: "interrupted",
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
    status = stale;
    const associate = spyOn(PullRequests, "associate").mockReturnValue(
      OkAsync({ reason: "pr_unchanged", data: {} }) as never,
    );
    expect(await run(["pr", "associate"])).toMatchObject({
      reason: "pr_worktree_unclean",
      state: { worktree_clean: false },
    });
    expect(associate).not.toHaveBeenCalled();
    status = { status: "completed", exitCode: 0, stdout: "", stderr: "" };
    const staleHead = { ...stale, stdout: "head\n" };
    head = staleHead;
    required(source.pullRequests.find((row) => row.assignment === "pr")).progress = JSON.stringify({
      seen: [],
      failures: [],
      eligibleHead: "head",
    });
    const merge = spyOn(PullRequests, "merge").mockReturnValue(
      OkAsync({ reason: "pr_merged", data: {} }) as never,
    );
    expect(await run(["pr", "merge"])).toMatchObject({
      reason: "pr_not_ready",
      state: { pr_ready: false },
    });
    expect(merge).not.toHaveBeenCalled();
  },
);

test("missing local and eligible heads do not count as matching readiness evidence", async () => {
  head = { status: "no-answer", detail: "interrupted" };
  const merge = spyOn(PullRequests, "merge").mockReturnValue(
    OkAsync({ reason: "pr_merged", data: {} }) as never,
  );
  expect(await run(["pr", "merge"])).toMatchObject({
    reason: "pr_not_ready",
    state: { pr_ready: false },
  });
  expect(merge).not.toHaveBeenCalled();
});

test("a recorded merge ends the worker tail", async () => {
  prActor();
  required(source.pullRequests.find((row) => row.assignment === "pr")).mergedAt =
    "2026-11-14T00:00:00Z";
  expect(await run()).toMatchObject({ kind: "implementation", phase: "complete" });
});

test("a report closing command checks kind guards even without a worktree", async () => {
  source.reports = [];
  status = { status: "unavailable", tool: "git", detail: "There is no worktree to probe." };
  const kind = WorkerKinds.resolve("research");
  kind.workPhases[0] = { name: "investigate", goal: "Investigate.", guard: "worktree_clean" };
  required(current.launch).kind = JSON.stringify(kind);
  const submit = spyOn(ReportAssignments, "submit").mockReturnValue(
    OkAsync({ reason: "report_submitted", data: {} }) as never,
  );
  expect(await run(["report", "submit", "--file", "fixture.json"])).toMatchObject({
    kind: "research",
    phase: "investigate",
  });
  expect(submit).toHaveBeenCalledTimes(1);
  kind.workPhases[0] = { name: "investigate", goal: "Investigate.", guard: "pr_merged" };
  required(current.launch).kind = JSON.stringify(kind);
  expect(await run(["report", "submit", "--file", "fixture.json"])).toMatchObject({
    reason: "pr_not_merged",
    state: { pr_merged: false },
  });
  expect(submit).toHaveBeenCalledTimes(1);
});

test("supervisor report commands are not mistaken for worker phase exits", async () => {
  prActor();
  const check = spyOn(WorkSources, "checkSupervisor").mockReturnValue(OkAsync(undefined) as never);
  spyOn(ReportAssignments, "accept").mockReturnValue(
    OkAsync({ reason: "report_accepted", data: {} }) as never,
  );
  expect(
    await run(["report", "accept", "--source", source.source.id, "--assignment", "other-report"]),
  ).toMatchObject({
    operation: "report_accept",
    reason: "report_accepted",
    kind: "implementation",
    phase: "feedback",
  });
  expect(check).toHaveBeenCalledTimes(1);
});

test("a returned report resumes only from its own assignment state", async () => {
  const receipt = required(source.reports.find((row) => row.assignment === "report"));
  receipt.decision = "returned";
  source.reports = [receipt];
  const other = required(source.assignments.find((row) => row.key === "other-pr"));
  other.state = "running";
  source.pullRequests = source.pullRequests.filter((row) => row.assignment !== "other-pr");
  source.assignments = [other, ...source.assignments.filter((row) => row !== other)];
  expect(await run()).toMatchObject({
    phase: "report",
    next: { command: "operator report resume" },
  });
});

function reviews() {
  prActor();
  const own = required(current.launch);
  own.internalReview = true;
  own.kind = JSON.stringify(WorkerKinds.resolve("review"));
  const other = required(source.launches.find((row) => row.assignment === "other-pr"));
  const previous = {
    ...own,
    id: own.id + "-previous",
    state: "finished",
    name: own.name + "-previous",
    endedAt: own.startedAt,
    attempt: 1,
    kind: JSON.stringify(WorkerKinds.resolve("implementation")),
  };
  own.attempt = 2;
  source.launches.unshift(previous);
  const fields = {
    sourceId: source.source.id,
    handoffState: "done",
    handoffDetail: null,
    startedAt: own.startedAt,
    updatedAt: own.startedAt,
    ownerPid: null,
    leaseAt: null,
    commentId: null,
    commentUrl: null,
    endedAt: null,
    handoffRunning: false,
  };
  source.internalReviews = [
    {
      ...fields,
      assignment: "other-pr",
      state: "ready",
      implementerLaunchId: other.id,
      readyHead: "head",
    },
    {
      ...fields,
      assignment: "pr",
      state: "reviewing",
      implementerLaunchId: previous.id,
      readyHead: null,
    },
  ];
  return { own, other };
}

test("an active review uses its own state and recorded round count", async () => {
  const { own, other } = reviews();
  expect(await run()).toMatchObject({ kind: "review", phase: "review" });
  source.internalReviewRounds = [
    {
      sourceId: source.source.id,
      assignment: "pr",
      number: 1,
      launchId: own.id,
      head: "head",
      findings: "[]",
      recordedAt: own.startedAt,
    },
    {
      sourceId: source.source.id,
      assignment: "other-pr",
      number: 1,
      launchId: other.id,
      head: "head",
      findings: "[]",
      recordedAt: own.startedAt,
    },
  ];
  const round = spyOn(PullRequests, "round").mockReturnValue(
    OkAsync({ reason: "pr_round_recorded", data: {} }) as never,
  );
  expect(await run(["pr", "round", "--file", "fixture.json"])).toMatchObject({
    kind: "review",
    phase: "ready",
    reason: "pr_round_recorded",
  });
  expect(round).toHaveBeenCalledTimes(1);
  source.internalReviewRounds.push({ ...required(source.internalReviewRounds[0]), number: 2 });
  expect(await run(["pr", "round", "--file", "fixture.json"])).toMatchObject({
    reason: "internal_review_round_limit",
    phase: "ready",
    state: { rounds: 2 },
  });
  expect(round).toHaveBeenCalledTimes(1);
});

test("an outgoing implementer's closing result names the handoff instead of reviewer work", async () => {
  const { own } = reviews();
  required(source.internalReviews.find((row) => row.assignment === "pr")).implementerLaunchId =
    own.id;
  expect(await run()).toMatchObject({
    phase: "handoff",
    next: { why: "This launch handed the PR to its reviewer. Stop here." },
  });
});
