import { expect, test } from "bun:test";
import { decideReport as reportDecision } from "./report-machine.ts";
import { expectRefusalContext } from "../../lib/cli-result-fixture.ts";

function decideReport(...args: Parameters<typeof reportDecision>) {
  const result = reportDecision(...args);
  if (result.tag === "Err") expectRefusalContext(result.error);
  return result;
}

const running = { id: "l1", state: "running", paneId: "w1:p1", herdrSocket: "/herdr.sock" };
function facts(input: {
  command: Parameters<typeof decideReport>[0]["command"];
  state: string;
  latest?: { number: number; decision: string | null; cleanupState: string | null } | null;
  launch?: (typeof running & { worktreePath?: string | null }) | null;
  caller?: { socket: string | null; paneId: string | null };
  completion?: string;
  promotion?: { sourceState: string; key: string };
}) {
  const completion = input.completion ?? "report";
  return {
    command: input.command,
    assignment: { key: "read", completion, state: input.state },
    assignments: [
      { key: "read", completion: "report" as const, state: "reported" as const },
      { key: "other", completion: "report" as const, state: "completed" as const },
    ],
    launch: input.launch === undefined ? running : input.launch,
    latest: input.latest ?? null,
    caller: input.caller ?? { socket: "/herdr.sock", paneId: "super:p0" },
    promotion: input.promotion,
  };
}
const submitted = { number: 1, decision: null, cleanupState: null };

test.each([
  [
    { command: "submit", state: "reported" },
    { assignment: "reported", decision: null },
  ],
  [
    { command: "submit", state: "ready", launch: null },
    { assignment: "ready", launch: null },
  ],
  [{ command: "accept", state: "running" }, { report: null }],
  [
    {
      command: "accept",
      state: "reported",
      latest: { number: 1, decision: "returned", cleanupState: null },
    },
    { assignment: "reported", decision: "returned" },
  ],
  [
    { command: "resume", state: "reported", latest: submitted },
    { assignment: "reported", decision: null, launch: "running" },
  ],
  [
    {
      command: "resume",
      state: "reported",
      latest: { number: 1, decision: "returned", cleanupState: null },
      launch: null,
    },
    { assignment: "reported", decision: "returned", launch: null },
  ],
  [
    { command: "return", state: "running" },
    { assignment: "running", decision: null },
  ],
  [
    { command: "cleanup", state: "reported", latest: submitted },
    { assignment: "reported", decision: null },
  ],
  [
    {
      command: "return",
      state: "running",
      latest: { number: 1, decision: "accepted", cleanupState: null },
    },
    { assignment: "running", decision: "accepted" },
  ],
  [
    {
      command: "cleanup",
      state: "reported",
      latest: { number: 1, decision: "returned", cleanupState: null },
    },
    { assignment: "reported", decision: "returned" },
  ],
  [{ command: "submit", state: "running", completion: "pr" }, { completion: "pr" }],
] satisfies [Parameters<typeof facts>[0], Record<string, unknown>][])(
  "report refusal exposes checked facts for %j",
  (input, state) => {
    expect(decideReport(facts(input))).toMatchObject({
      tag: "Err",
      error: { state },
    });
  },
);

test("promotion names an unknown or ended source without inferring its state", () => {
  expect(
    decideReport(facts({ command: "promote", state: "reported", latest: submitted })),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "source_ended",
      detail: "The source is unknown. Nothing changed.",
      state: { source: null },
    },
  });
  expect(
    decideReport(
      facts({
        command: "promote",
        state: "reported",
        latest: submitted,
        promotion: { sourceState: "reset", key: "build" },
      }),
    ),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "source_ended",
      detail: "The source is reset. Nothing changed.",
      state: { source: "reset" },
    },
  });
});

test("a running worker submits the next report, and submission is not completion", () => {
  expect(decideReport(facts({ command: "submit", state: "running" }))).toMatchObject({
    tag: "Ok",
    value: { assignmentState: "reported", report: { insert: 1 } },
  });
  expect(
    decideReport(
      facts({
        command: "submit",
        state: "running",
        latest: { number: 2, decision: "returned", cleanupState: null },
      }),
    ),
  ).toMatchObject({ value: { report: { insert: 3 } } });
  for (const [state, launch, reason] of [
    ["reported", running, "report_awaiting_decision"],
    ["ready", null, "assignment_not_running"],
    ["running", { ...running, state: "starting" }, "assignment_not_running"],
    ["completed", running, "assignment_not_running"],
  ] as const)
    expect(decideReport(facts({ command: "submit", state, launch }))).toMatchObject({
      tag: "Err",
      error: { reason },
    });
});

test("a submit after a return names the resume, not a pending decision", () => {
  const returned = { number: 1, decision: "returned", cleanupState: null };
  const refused = decideReport(facts({ command: "submit", state: "reported", latest: returned }));
  expect(refused).toMatchObject({
    tag: "Err",
    error: {
      reason: "report_returned",
      next: {
        command: "operator report resume",
        why: "Read the returned report's follow-up before submitting again.",
      },
      state: { assignment: "reported", decision: "returned" },
    },
  });
  expect(refused.tag === "Err" && refused.error.detail).toContain("operator report resume");
});

test("PR assignments have no report transitions", () => {
  for (const command of ["submit", "resume", "accept", "promote", "return", "cleanup"] as const)
    expect(decideReport(facts({ command, state: "running", completion: "pr" }))).toMatchObject({
      error: { reason: "assignment_not_report" },
    });
});

test("acceptance completes the report, ends the launch, and finishes a complete source", () => {
  expect(
    decideReport(facts({ command: "accept", state: "reported", latest: submitted })),
  ).toMatchObject({
    tag: "Ok",
    value: {
      assignmentState: "completed",
      sourceFinished: true,
      finishLaunch: "l1",
      report: { update: 1, decision: "accepted" },
      cleanup: "pending",
    },
  });
  const interrupted = decideReport(
    facts({
      command: "accept",
      state: "reported",
      latest: submitted,
      launch: { ...running, state: "interrupted" },
    }),
  );
  expect(interrupted).toMatchObject({ tag: "Ok", value: { finishLaunch: undefined } });
  for (const [state, latest] of [
    ["running", null],
    ["reported", { number: 1, decision: "returned", cleanupState: null }],
    ["completed", { number: 1, decision: "accepted", cleanupState: "done" }],
  ] as const)
    expect(decideReport(facts({ command: "accept", state, latest }))).toMatchObject({
      error: { reason: "report_not_submitted" },
    });
});

const worktree = { ...running, worktreePath: "/worktrees/read" };
const promotion = { sourceState: "open", key: "build" };

test("a promotion accepts the report, keeps the source open, and names the new assignment", () => {
  expect<unknown>(
    decideReport(
      facts({
        command: "promote",
        state: "reported",
        latest: submitted,
        launch: worktree,
        promotion,
      }),
    ),
  ).toEqual({
    tag: "Ok",
    value: {
      assignmentState: "completed",
      sourceFinished: false,
      finishLaunch: "l1",
      report: { update: 1, decision: "accepted" },
      promote: { key: "build" },
    },
  });
  expect(
    decideReport(
      facts({
        command: "promote",
        state: "reported",
        latest: submitted,
        launch: { ...worktree, state: "interrupted" },
        promotion,
      }),
    ),
  ).toMatchObject({ tag: "Ok", value: { finishLaunch: undefined, promote: { key: "build" } } });
});

test("a promotion refuses an ended source, a decided report, a pane report, and a taken key", () => {
  const accepted = { number: 1, decision: "accepted", cleanupState: "done" };
  for (const [input, reason, state] of [
    [{ promotion: { sourceState: "reset", key: "build" } }, "source_ended", { source: "reset" }],
    [{ promotion: undefined }, "source_ended", { source: null }],
    [
      { state: "completed", latest: accepted },
      "report_not_submitted",
      { assignment: "completed", decision: "accepted" },
    ],
    [
      { latest: { ...submitted, decision: "returned" } },
      "report_not_submitted",
      { assignment: "reported", decision: "returned" },
    ],
    [{ latest: null }, "report_not_submitted", { assignment: "reported", decision: null }],
    [{ launch: running }, "promotion_worktree_missing", { worktree: null }],
    [
      { launch: { ...running, worktreePath: null } },
      "promotion_worktree_missing",
      { worktree: null },
    ],
    [{ launch: null }, "promotion_worktree_missing", { worktree: null }],
    [
      { promotion: { sourceState: "open", key: "other" } },
      "promotion_key_taken",
      { assignmentExists: true },
    ],
  ] as const)
    expect(
      decideReport(
        facts({
          command: "promote",
          state: "reported",
          latest: submitted,
          launch: worktree,
          promotion,
          ...input,
        }),
      ),
    ).toMatchObject({ tag: "Err", error: { reason, state } });
});

test("a repeated acceptance retries only unfinished cleanup", () => {
  for (const cleanupState of ["pending", "failed"])
    expect(
      decideReport(
        facts({
          command: "accept",
          state: "completed",
          latest: { number: 1, decision: "accepted", cleanupState },
        }),
      ),
    ).toMatchObject({ value: { retry: true, cleanup: "pending", report: { update: 1 } } });
});

test("the worker's own pane cannot accept or return, but another server's same pane id can", () => {
  for (const command of ["accept", "promote", "return"] as const) {
    expect(
      decideReport(
        facts({
          command,
          state: "reported",
          latest: submitted,
          launch: worktree,
          promotion: { sourceState: "open", key: "build" },
          caller: { socket: "/herdr.sock", paneId: "w1:p1" },
        }),
      ),
    ).toMatchObject({
      error: { reason: "self_decision_refused", state: { samePane: true, sameServer: true } },
    });
    expect(
      decideReport(
        facts({
          command,
          state: "reported",
          latest: submitted,
          launch: worktree,
          promotion: { sourceState: "open", key: "build" },
          caller: { socket: "/other.sock", paneId: "w1:p1" },
        }),
      ).tag,
    ).toBe("Ok");
  }
});

test("a return keeps the report state, and only a returned report resumes", () => {
  expect<unknown>(
    decideReport(facts({ command: "return", state: "reported", latest: submitted })),
  ).toEqual({
    tag: "Ok",
    value: { report: { update: 1, decision: "returned" } },
  });
  const returned = { number: 1, decision: "returned", cleanupState: null };
  expect(
    decideReport(facts({ command: "resume", state: "reported", latest: returned })),
  ).toMatchObject({ value: { assignmentState: "running", report: { update: 1 } } });
  for (const input of [
    { state: "reported", latest: submitted },
    { state: "reported", latest: returned, launch: { ...running, state: "interrupted" } },
    { state: "running", latest: returned },
  ])
    expect(decideReport(facts({ command: "resume", ...input }))).toMatchObject({
      error: { reason: "report_not_returned" },
    });
});

test("only an accepted report records a cleanup outcome", () => {
  expect(
    decideReport(
      facts({
        command: "cleanup",
        state: "completed",
        latest: { number: 2, decision: "accepted", cleanupState: "pending" },
      }),
    ),
  ).toMatchObject({ value: { report: { update: 2 } } });
  expect(
    decideReport(facts({ command: "cleanup", state: "reported", latest: submitted })),
  ).toMatchObject({ error: { reason: "report_not_accepted" } });
});
