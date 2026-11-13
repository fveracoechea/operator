import { expect, test } from "bun:test";
import { decideReport, type ReportCommand } from "./report-machine.ts";

type Latest = { number: number; decision: string | null; cleanupState: string | null } | null;
type Launch = { id: string; state: string; paneId: string | null; herdrSocket: string | null };
type Row = { key: string; completion: "report"; state: "ready" | "reported" | "completed" };

const worker: Launch = { id: "l1", state: "running", paneId: "w1:p1", herdrSocket: "/herdr.sock" };
type Caller = { socket: string | null; paneId: string | null };
const superAgent: Caller = { socket: "/herdr.sock", paneId: "super:p0" };

function decide(
  command: ReportCommand,
  state: string,
  options: { latest?: Latest; launch?: Launch | null; others?: Row[]; caller?: Caller } = {},
) {
  return decideReport({
    command,
    assignment: { key: "read", completion: "report", state },
    assignments: [
      { key: "read", completion: "report", state: "reported" },
      ...(options.others ?? []),
    ],
    launch: options.launch === undefined ? worker : options.launch,
    latest: options.latest === undefined ? null : options.latest,
    caller: options.caller ?? superAgent,
  });
}

function refusal(reason: string, detail: string) {
  return { tag: "Err", error: { reason, detail } };
}

const submitted = { number: 2, decision: null, cleanupState: null };
const returned = { number: 2, decision: "returned", cleanupState: null };
const accepted = { number: 2, decision: "accepted", cleanupState: "done" };

test("submission refusals name the report and the missing worker", () => {
  expect(decide("submit", "reported", { latest: submitted })).toMatchObject(
    refusal(
      "report_awaiting_decision",
      "Report 2 of read awaits the SuperAgent's decision. Nothing changed.",
    ),
  );
  expect(decide("submit", "reported")).toMatchObject(
    refusal(
      "report_awaiting_decision",
      "Report 0 of read awaits the SuperAgent's decision. Nothing changed.",
    ),
  );
  expect(decide("submit", "running", { launch: null })).toMatchObject(
    refusal(
      "assignment_not_running",
      "Assignment read has no running worker launch. Nothing changed.",
    ),
  );
  // The worker submits from its own pane.
  expect(
    decide("submit", "running", { caller: { socket: "/herdr.sock", paneId: "w1:p1" } }),
  ).toMatchObject({ tag: "Ok", value: { assignmentState: "reported", report: { insert: 1 } } });
});

test("PR work has no report and the worker never decides its own report", () => {
  expect(
    decideReport({
      command: "accept",
      assignment: { key: "read", completion: "pr", state: "running" },
      assignments: [],
      launch: worker,
      latest: null,
      caller: superAgent,
    }),
  ).toMatchObject(
    refusal("assignment_not_report", "read completes through a PR. Nothing changed."),
  );
  const own = { socket: "/herdr.sock", paneId: "w1:p1" };
  for (const command of ["accept", "return"] as const)
    expect(decide(command, "reported", { latest: submitted, caller: own })).toMatchObject(
      refusal(
        "self_decision_refused",
        "A WorkerAgent cannot accept or return its own report. The supervising SuperAgent decides from its own pane. Nothing changed.",
      ),
    );
  // A launch with no recorded pane matches no caller, even a caller outside Herdr.
  const paneless = { ...worker, paneId: null, herdrSocket: null };
  expect(
    decide("accept", "reported", {
      latest: submitted,
      launch: paneless,
      caller: { socket: null, paneId: null },
    }),
  ).toMatchObject({ tag: "Ok" });
  expect(decide("accept", "reported", { latest: submitted, launch: null })).toMatchObject({
    tag: "Ok",
  });
});

test("acceptance completes the report and finishes the source only with all other work complete", () => {
  expect(decide("accept", "reported", { latest: submitted })).toMatchObject({
    tag: "Ok",
    value: {
      assignmentState: "completed",
      sourceFinished: true,
      finishLaunch: "l1",
      report: { update: 2, decision: "accepted" },
      cleanup: "pending",
    },
  });
  expect(
    decide("accept", "reported", {
      latest: submitted,
      others: [{ key: "next", completion: "report", state: "ready" }],
    }),
  ).toMatchObject({ value: { sourceFinished: false } });
  expect(
    decide("accept", "reported", {
      latest: submitted,
      others: [{ key: "next", completion: "report", state: "completed" }],
    }),
  ).toMatchObject({ value: { sourceFinished: true } });
  const ended = decide("accept", "reported", {
    latest: submitted,
    launch: { ...worker, state: "interrupted" },
  });
  expect(ended.tag === "Ok" ? ended.value.finishLaunch : "missing").toBeUndefined();
  const none = decide("accept", "reported", { latest: submitted, launch: null });
  expect(none.tag === "Ok" ? none.value.finishLaunch : "missing").toBeUndefined();
});

test("acceptance refuses without a submitted report and retries only unfinished cleanup", () => {
  expect(decide("accept", "reported", { latest: null })).toMatchObject(
    refusal("report_not_submitted", "read has no report. Nothing changed."),
  );
  const waiting = refusal(
    "report_not_submitted",
    "read has no submitted report that awaits a decision. Nothing changed.",
  );
  expect(decide("accept", "running", { latest: submitted })).toMatchObject(waiting);
  expect(
    decide("accept", "reported", { latest: { ...accepted, cleanupState: "failed" } }),
  ).toMatchObject(waiting);
  expect(
    decide("accept", "completed", { latest: { ...returned, cleanupState: "failed" } }),
  ).toMatchObject(waiting);
  const retried = decide("accept", "completed", {
    latest: { ...accepted, cleanupState: "failed" },
  });
  expect(retried.tag === "Ok" ? retried.value : null).toEqual({
    report: { update: 2 },
    cleanup: "pending",
    retry: true,
  });
});

test("only a returned report of a running worker resumes", () => {
  expect(decide("resume", "reported", { latest: returned })).toMatchObject({
    tag: "Ok",
    value: { assignmentState: "running", report: { update: 2 } },
  });
  const refused = refusal(
    "report_not_returned",
    "read has no returned report for this running worker. Nothing changed.",
  );
  for (const options of [
    { latest: null },
    { latest: submitted },
    { latest: returned, launch: null },
    { latest: returned, launch: { ...worker, state: "interrupted" } },
  ])
    expect(decide("resume", "reported", options)).toMatchObject(refused);
  expect(decide("resume", "running", { latest: returned })).toMatchObject(refused);
});

test("only a submitted report awaiting a decision is returned", () => {
  expect(decide("return", "reported", { latest: submitted })).toMatchObject({
    tag: "Ok",
    value: { report: { update: 2, decision: "returned" } },
  });
  const refused = refusal(
    "report_not_submitted",
    "read has no submitted report that awaits a decision. Nothing changed.",
  );
  expect(decide("return", "reported", { latest: null })).toMatchObject(refused);
  expect(decide("return", "reported", { latest: returned })).toMatchObject(refused);
  expect(decide("return", "running", { latest: submitted })).toMatchObject(refused);
});

test("only an accepted report of completed work records a cleanup outcome", () => {
  const recorded = decide("cleanup", "completed", { latest: accepted });
  expect(recorded.tag === "Ok" ? recorded.value : null).toEqual({ report: { update: 2 } });
  const refused = refusal("report_not_accepted", "read has no accepted report. Nothing changed.");
  expect(decide("cleanup", "completed", { latest: null })).toMatchObject(refused);
  expect(decide("cleanup", "completed", { latest: returned })).toMatchObject(refused);
  expect(decide("cleanup", "reported", { latest: accepted })).toMatchObject(refused);
});
