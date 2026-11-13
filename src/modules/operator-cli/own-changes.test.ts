import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { ownChangeSelector, withOwnChanges } from "./own-changes.ts";

const paths = OperatorHome.resolve(Environment.parse({ HOME: "/isolated/own", NODE_ENV: "test" }));
afterEach(() => {
  mock.restore();
});

test("a SuperAgent command names the source and assignment that it changes", () => {
  expect(
    ownChangeSelector(["message", "close", "--source", "s1", "--assignment", "a", "--key", "k"]),
  ).toEqual({ sourceId: "s1", assignment: "a" });
  expect(ownChangeSelector(["dispatch", "--assignment", "a", "--source", "s1"])).toEqual({
    sourceId: "s1",
    assignment: "a",
  });
  expect(ownChangeSelector(["source", "reset", "--source", "s1", "--json"])).toEqual({
    sourceId: "s1",
    assignment: undefined,
  });
  expect(ownChangeSelector(["source", "register", "--file", "plan.json"])).toEqual({
    sourceId: undefined,
    assignment: undefined,
  });
  expect(ownChangeSelector(["question", "escalate", "--source", "--assignment", "a"])).toEqual({
    sourceId: undefined,
    assignment: "a",
  });
});

test("waits, reads, and worker commands are not SuperAgent changes", () => {
  for (const args of [
    ["next", "--wait"],
    ["source", "show", "--source", "s1"],
    ["question", "ask", "--file", "q.json"],
    ["message", "ack", "--key", "k"],
    ["pr", "wait"],
    ["review", "wait"],
    [],
  ])
    expect(ownChangeSelector(args)).toBeNull();
});

test("a SuperAgent command from an agent session runs inside the acknowledgement", async () => {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    OPENCODE_SESSION_ID: "ses-1",
    CLAUDE_CODE_SESSION_ID: undefined,
  });
  const acknowledge = spyOn(WorkSources, "acknowledgeOwnChange").mockImplementation(
    async (_input, change) => change(),
  );
  const run = mock(async () => undefined);
  await withOwnChanges(["message", "send", "--source", "s1", "--assignment", "a"], paths, run);
  expect(run).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith(
    { paths, cwd: process.cwd(), session: "ses-1", sourceId: "s1", assignment: "a" },
    run,
  );
});

test("another command, or a command outside an agent session, runs without an acknowledgement", async () => {
  const acknowledge = spyOn(WorkSources, "acknowledgeOwnChange");
  const read = spyOn(Environment, "read");
  const run = mock(async () => undefined);
  for (const [id, args] of [
    ["ses-1", ["next", "--wait"]],
    [undefined, ["dispatch", "--source", "s1"]],
    // An empty variable names no session.
    ["", ["dispatch", "--source", "s1"]],
  ] as const) {
    read.mockReturnValueOnce(
      Environment.parse({ HOME: "/isolated/own", NODE_ENV: "test", OPENCODE_SESSION_ID: id }),
    );
    await withOwnChanges([...args], paths, run);
  }
  expect(run).toHaveBeenCalledTimes(3);
  expect(acknowledge).not.toHaveBeenCalled();
});
