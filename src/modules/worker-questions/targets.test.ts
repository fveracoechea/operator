import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err } from "unthrown";
import { Environment } from "../environment/main.ts";
import { caller, now, stop, workerPane } from "./targets.ts";

afterEach(() => {
  mock.restore();
});

function inPane(env: { HERDR_PANE_ID?: string; HERDR_SOCKET_PATH?: string }) {
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), ...env });
}

test("the caller is the Herdr pane and socket that run the command", () => {
  inPane({ HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/herdr.sock" });
  expect(caller()).toEqual({ socket: "/herdr.sock", paneId: "w1:p1" });
  expect(workerPane()).toMatchObject({
    tag: "Ok",
    value: { by: "pane", socket: "/herdr.sock", paneId: "w1:p1" },
  });
});

test("a worker command outside a Herdr pane refuses", () => {
  const refused = {
    tag: "Err",
    error: {
      reason: "worker_pane_required",
      detail:
        "Run this command in the Herdr pane that Operator dispatched for the assignment. Nothing changed.",
    },
  };
  for (const env of [
    { HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: "/herdr.sock" },
    { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: undefined },
  ]) {
    inPane(env);
    expect(caller()).toMatchObject({ [env.HERDR_PANE_ID ? "socket" : "paneId"]: null });
    expect(workerPane()).toMatchObject(refused);
    mock.restore();
  }
});

test("stop carries a refusal into another result, and the time is an ISO timestamp", () => {
  const refusal = { reason: "x", detail: "y" };
  expect(stop(Err(refusal))).toMatchObject({ tag: "Err", error: refusal });
  expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
