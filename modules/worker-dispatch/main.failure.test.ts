import { afterAll, afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { OkAsync, fromPromise } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { dispatchDevice, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

test("a pane that ends during the start leaves the launch interrupted", async () => {
  await using device = await dispatchDevice();
  device.herdr.prompt.mockImplementation(() => {
    device.exited("p1");
    return OkAsync(null);
  });
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_interrupted",
      detail:
        "Herdr reported that the pane ended before the launch finished, so the launch is recorded as interrupted. Read operator next before a replacement.",
    },
  });
  expect(await device.launches("read")).toMatchObject([
    { state: "interrupted", failureReason: "pane_ended" },
  ]);
});

test("a defect during the start is recorded as a failed launch", async () => {
  await using device = await dispatchDevice();
  device.herdr.prompt.mockReturnValue(
    fromPromise(Promise.reject(new TypeError("boom")), (cause, defect) => defect(cause)),
  );
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_failed",
      detail:
        "launch_defect: Dispatch stopped: TypeError: boom The launch is recorded as failed. Read operator next before a replacement.",
    },
  });
  expect(await device.launches("read")).toMatchObject([
    { state: "failed", failureReason: "launch_defect" },
  ]);
});

test("a brief that cannot be written fails the recorded start", async () => {
  await using device = await dispatchDevice();
  const files = OperatorHome.assignmentFiles(device.paths, {
    repository: "example/one",
    sourceId: device.sourceId,
    assignment: "read",
  });
  // A folder at the brief path makes the write fail with a filesystem error.
  await Bun.write(`${files.brief}/blocked`, "x\n", { createPath: true });
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({
    tag: "Err",
    error: { reason: "launch_failed" },
  });
  expect(await device.launches("read")).toMatchObject([
    { state: "failed", failureReason: "dispatch_io_failed" },
  ]);
  expect(device.herdr.startAgent).not.toHaveBeenCalled();
});

test.each([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("a %s during the start records the stop before exit %d", async (signal, code) => {
  await using device = await dispatchDevice();
  const listeners = process.listenerCount(signal);
  const exit = spyOn(process, "exit").mockImplementation(() => undefined as never);
  device.herdr.startAgent.mockImplementation(() => {
    process.emit(signal);
    return OkAsync(null);
  });
  await WorkerDispatch.dispatch(device.request("read"));
  expect(exit).toHaveBeenCalledWith(code);
  expect(await device.launches("read")).toMatchObject([
    {
      state: "failed",
      failureReason: "launch_stopped",
      failureDetail: `Dispatch received ${signal} before it recorded a launch outcome.`,
    },
  ]);
  // The handlers end with the start, so a later signal does not touch the launch.
  expect(process.listenerCount(signal)).toBe(listeners);
});

test("the start holds its launch lease until it records an outcome", async () => {
  await using device = await dispatchDevice();
  const release = mock(() => {});
  const hold = spyOn(DeviceState, "holdLaunch").mockReturnValue(release);
  device.herdr.startAgent.mockImplementation(() => {
    expect(release).not.toHaveBeenCalled();
    return OkAsync(null);
  });
  expect(await WorkerDispatch.dispatch(device.request("read"))).toMatchObject({ tag: "Ok" });
  const [launch] = await device.launches("read");
  expect(hold).toHaveBeenCalledWith(device.paths, launch?.id);
  expect(release).toHaveBeenCalledTimes(1);
});
