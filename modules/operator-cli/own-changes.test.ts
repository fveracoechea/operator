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

function pane(id: string | undefined) {
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), HERDR_PANE_ID: id });
}

test("a SuperAgent command from a pane runs inside the acknowledgement", async () => {
  pane("pane-1");
  const acknowledge = spyOn(WorkSources, "acknowledgeOwnChange").mockImplementation(
    async (_input, change) => change(),
  );
  const run = mock(async () => undefined);
  await withOwnChanges(["message", "send", "--source", "s1", "--assignment", "a"], paths, run);
  expect(run).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith(
    { paths, cwd: process.cwd(), paneId: "pane-1", sourceId: "s1", assignment: "a" },
    run,
  );
});

test("another command, or a command outside a pane, runs without an acknowledgement", async () => {
  const acknowledge = spyOn(WorkSources, "acknowledgeOwnChange");
  const read = spyOn(Environment, "read");
  const run = mock(async () => undefined);
  for (const [id, args] of [
    ["pane-1", ["next", "--wait"]],
    [undefined, ["dispatch", "--source", "s1"]],
    ["", ["dispatch", "--source", "s1"]],
  ] as const) {
    read.mockReturnValueOnce({
      ...Environment.parse({ HOME: "/isolated/own", NODE_ENV: "test" }),
      HERDR_PANE_ID: id,
    });
    await withOwnChanges([...args], paths, run);
  }
  expect(run).toHaveBeenCalledTimes(3);
  expect(acknowledge).not.toHaveBeenCalled();
});
