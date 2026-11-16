import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { fromPromise, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { prDevice, repository } from "./device-fixture.ts";
import { handoff } from "./internal-review.ts";

afterEach(() => mock.restore());

test("a dispatch defect during handoff keeps the recorded recovery instead of losing its cause", async () => {
  await using device = await prDevice();
  const socket = `${device.root}/herdr.sock`;
  const started = device.start("parent", { socket });
  expect(
    DeviceState.associatePullRequest(
      device.paths,
      started.launchId,
      {
        number: 7,
        url: `https://github.com/${repository}/pull/7`,
        branch: "task/parent",
        relay: null,
      },
      false,
      true,
    ).tag,
  ).toBe("Ok");
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), HERDR_SOCKET_PATH: socket });
  const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(
    fromPromise(Promise.reject(new Error("dispatch defect")), (cause, defect) => defect(cause)),
  );
  expect(
    await handoff({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: null,
    }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "handoff_defect",
      detail: "Error: dispatch defect",
      next: {
        decider: "super-agent",
        question:
          "How should the failed internal-review handoff be recovered from its recorded progress?",
      },
    },
  });
  expect(close.mock.calls).toEqual([["p1"]]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
    tag: "Ok",
    value: [
      {
        launches: [{ state: "finished", paneId: "p1" }],
        internalReviews: [{ handoffState: "failed" }],
      },
    ],
  });
  expect(device.calls).toEqual([]);
});

test.each(["mismatch", "defect"] as const)(
  "a handoff %s keeps its owner recovery and starts no reviewer",
  async (kind) => {
    await using device = await prDevice();
    const socket = `${device.root}/herdr.sock`;
    const started = device.start("parent", { socket });
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        started.launchId,
        {
          number: 7,
          url: `https://github.com/${repository}/pull/7`,
          branch: "task/parent",
          relay: null,
        },
        false,
        true,
      ).tag,
    ).toBe("Ok");
    const environment = Environment.read();
    spyOn(Environment, "read").mockReturnValue({
      ...environment,
      HERDR_SOCKET_PATH: kind === "mismatch" ? "/other-session" : socket,
    });
    const close = spyOn(Herdr, "closePane").mockReturnValue(
      fromPromise(Promise.reject(new Error("injected")), (cause, defect) => defect(cause)),
    );
    const dispatch = spyOn(WorkerDispatch, "dispatch");
    const result = await handoff({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: null,
    });
    if (kind === "mismatch") {
      expect(result).toMatchObject({
        tag: "Err",
        error: {
          reason: "herdr_session_mismatch",
          detail:
            "Run operator handoff in a pane of the Herdr session that started the implementer.",
          next: {
            decider: "super-agent",
            question: "Which pane of the recorded Herdr session should retry this handoff?",
          },
          state: { expectedSocket: socket, actualSocket: "/other-session" },
        },
      });
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        tag: "Err",
        error: {
          reason: "handoff_defect",
          detail: "Error: injected",
          next: {
            decider: "super-agent",
            question:
              "How should the failed internal-review handoff be recovered from its recorded progress?",
          },
        },
      });
      expect(close.mock.calls).toEqual([["p1"]]);
      expect(result.tag === "Err" ? result.error.state : "unexpected").toBeUndefined();
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
    expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
      tag: "Ok",
      value: [
        {
          launches: [{ state: "running", paneId: "p1" }],
          internalReviews: [{ handoffState: "failed" }],
        },
      ],
    });
  },
);
