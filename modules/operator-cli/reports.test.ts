import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ReportAssignments } from "../report-assignments/main.ts";
import { reportArgs, runReports } from "./reports.ts";

const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

function quiet() {
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function completed(reason: string) {
  return OkAsync({ reason, data: { report: 1 } }) as never;
}

function spies() {
  return {
    submit: spyOn(ReportAssignments, "submit").mockReturnValue(completed("report_submitted")),
    resume: spyOn(ReportAssignments, "resume").mockReturnValue(completed("report_resumed")),
    accept: spyOn(ReportAssignments, "accept").mockReturnValue(completed("report_accepted")),
    return: spyOn(ReportAssignments, "return").mockReturnValue(completed("report_returned")),
  };
}

test("worker commands take no assignment selector, and SuperAgent commands name one", () => {
  expect(reportArgs(["report", "submit", "--file", "r.json", "--json"])).toEqual({
    command: "submit",
    file: "r.json",
    sourceId: "",
    assignment: "",
  });
  expect(reportArgs(["report", "resume"])).toMatchObject({ command: "resume" });
  expect(reportArgs(["report", "accept", "--source", "s", "--assignment", "a"])).toMatchObject({
    command: "accept",
    sourceId: "s",
    assignment: "a",
  });
  expect(
    reportArgs(["report", "return", "--assignment", "a", "--file", "f.md", "--source", "s"]),
  ).toMatchObject({ command: "return", sourceId: "s", assignment: "a", file: "f.md" });
  for (const args of [
    ["report"],
    ["report", "complete"],
    ["report", "submit"],
    ["report", "submit", "--file", "r.json", "--source", "s"],
    ["report", "resume", "--assignment", "a"],
    ["report", "accept", "--source", "s"],
    ["report", "accept", "--source", "s", "--source", "t", "--assignment", "a"],
    ["report", "return", "--source", "s", "--assignment", "a"],
    ["report", "submit", "--file", "--json"],
    ["report", "resume", "--json", "--json"],
    ["other", "submit", "--file", "r.json"],
    ["report", "accept", "--source", "s", "--assignment"],
    ["report", "accept", "--source", "s", "--assignment", "--json"],
  ])
    expect(reportArgs(args)).toBeNull();
});

test("refuses invalid report commands before any report operation", async () => {
  const called = spies();
  for (const args of [
    ["report", "submit"],
    ["report", "complete"],
    ["report", "resume", "--x"],
  ])
    expect(await runReports(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("passes each command to the matching report operation", async () => {
  const called = spies();
  const { log } = quiet();
  const cwd = process.cwd();
  const none = { file: "", sourceId: "", assignment: "" };
  await runReports(["report", "submit", "--file", "r.json"], paths, true);
  expect(called.submit).toHaveBeenCalledWith({
    paths,
    cwd,
    ...none,
    command: "submit",
    file: "r.json",
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ operation: "report_submit" });
  await runReports(["report", "resume"], paths, true);
  expect(called.resume).toHaveBeenCalledWith({ paths, cwd, ...none, command: "resume" });
  await runReports(["report", "accept", "--source", "s", "--assignment", "a"], paths, true);
  expect(called.accept).toHaveBeenCalledWith({
    paths,
    cwd,
    command: "accept",
    file: "",
    sourceId: "s",
    assignment: "a",
  });
  await runReports(
    ["report", "return", "--source", "s", "--assignment", "a", "--file", "f.md"],
    paths,
    true,
  );
  expect(called.return).toHaveBeenCalledWith({
    paths,
    cwd,
    command: "return",
    file: "f.md",
    sourceId: "s",
    assignment: "a",
  });
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "report_return",
    reason: "report_returned",
  });
  for (const spy of Object.values(called)) expect(spy).toHaveBeenCalledTimes(1);
});

test("prints a completed operation as compact JSON or as indented text", async () => {
  spies();
  const { log } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "report_resume",
    outcome: "completed",
    reason: "report_resumed",
    blockers: [],
    data: { report: 1 },
  };
  process.exitCode = 7;
  expect(await runReports(["report", "resume"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runReports(["report", "resume"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
});

test.each([
  ["invalid_report_input", 2],
  ["report_io_failed", 1],
  ["state_busy", 1],
  ["state_io_failed", 1],
  ["project_io_failed", 1],
  ["controller_mismatch", 4],
  ["controller_identity_mismatch", 4],
  ["report_changed", 4],
  ["self_decision_refused", 4],
  ["worker_launch_not_found", 4],
  ["report_missing", 3],
])("refuses %s with exit code %d", async (reason, code) => {
  spyOn(ReportAssignments, "resume").mockReturnValue(
    ErrAsync({ reason, detail: "not resumed" }) as never,
  );
  const { log, error } = quiet();
  expect(await runReports(["report", "resume"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "report_resume",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not resumed");
  expect(process.exitCode).toBe(code);
});

test("reports a report defect with exit code 1", async () => {
  spyOn(ReportAssignments, "accept").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))) as never,
  );
  const { log, error } = quiet();
  expect(
    await runReports(["report", "accept", "--source", "s", "--assignment", "a"], paths, true),
  ).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "report_accept",
    reason: "report_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
