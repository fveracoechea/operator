import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Herdr } from "../herdr/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { dispatchDevice, git } from "./dispatch-fixture.ts";
import { handOver } from "./handover.ts";
import { expectRefusalContext } from "../../lib/cli-result-fixture.ts";

afterEach(() => mock.restore());

const assignment = { key: "build", trackerKey: "github:example/one#9", branch: "task/build" };
const worker = {
  name: "report-worker",
  state: "running",
  paneId: "p1",
  tabId: "t1",
  herdrSocket: "/isolated.sock",
  branch: null,
};

test("handover refuses the wrong server before reads or outward effects", async () => {
  await using device = await dispatchDevice();
  const names = spyOn(DeviceState, "launchNames");
  const tools = spyOn(ToolInvocation, "run");
  const agents = spyOn(Herdr, "agentNames");
  const before = await Bun.file(device.paths.database).arrayBuffer();
  const result = await handOver({
    paths: device.paths,
    checkout: device.checkout,
    callerSocket: "/other.sock",
    assignment,
    launch: { ...worker, worktreePath: device.checkout },
  });
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "promotion_herdr_server",
      next: {
        decider: "super-agent",
        question: "Which recorded Herdr server must run this promotion?",
      },
      state: { serverMatches: false },
    },
  });
  expect(names).not.toHaveBeenCalled();
  expect(tools).not.toHaveBeenCalled();
  expect(agents).not.toHaveBeenCalled();
  expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
});

test("handover name exhaustion changes no names, branch, or state", async () => {
  await using device = await dispatchDevice();
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([worker.name]));
  spyOn(DeviceState, "launchNames").mockReturnValue(
    Ok([
      "pr-one-9-build",
      ...Array.from({ length: 998 }, (_, index) => `pr-one-9-build-${index + 2}`),
    ]),
  );
  const rename = spyOn(Herdr, "renameAgent").mockReturnValue(OkAsync(undefined));
  const label = spyOn(Herdr, "renameTab").mockReturnValue(OkAsync(undefined));
  const branches = git(device.checkout, "branch", "--list");
  const before = await Bun.file(device.paths.database).arrayBuffer();
  const result = await handOver({
    paths: device.paths,
    checkout: device.checkout,
    callerSocket: worker.herdrSocket,
    assignment,
    launch: { ...worker, worktreePath: device.checkout },
  });
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "launch_name_exhausted",
      next: {
        decider: "super-agent",
        question: "Which unused branch and worktree names should this assignment use?",
      },
      state: { namesAvailable: false },
    },
  });
  expect(rename).not.toHaveBeenCalled();
  expect(label).not.toHaveBeenCalled();
  expect(git(device.checkout, "branch", "--list")).toBe(branches);
  expect(await Bun.file(device.paths.database).arrayBuffer()).toEqual(before);
});

test("branch and undo failures report unconfirmed effects without inferring a rename outcome", async () => {
  await using device = await dispatchDevice();
  git(device.checkout, "branch", "report/read");
  const run = ToolInvocation.run.bind(ToolInvocation);
  const calls = spyOn(ToolInvocation, "run").mockImplementation((input) =>
    input.args.includes("-m")
      ? Promise.resolve({ status: "completed", exitCode: 1, stdout: "", stderr: "rename denied" })
      : run(input),
  );
  const input = {
    paths: device.paths,
    checkout: device.checkout,
    callerSocket: worker.herdrSocket,
    assignment,
    launch: {
      ...worker,
      state: "interrupted",
      paneId: null,
      branch: "report/read",
      worktreePath: device.checkout,
    },
  };
  const denied = await handOver(input);
  expect(denied).toMatchObject({
    tag: "Err",
    error: {
      reason: "promotion_branch_failed",
      next: {
        decider: "super-agent",
        question: "How should the branch rename be verified before promotion is retried?",
      },
      state: { renameConfirmed: false },
    },
  });
  expect(git(device.checkout, "branch", "--list", "report/read")).toContain("report/read");
  calls.mockImplementation(run);
  const handed = await handOver(input);
  expect(handed.tag).toBe("Ok");
  if (handed.tag !== "Ok") return;
  expect(git(device.checkout, "branch", "--list", "task/build")).toContain("task/build");
  calls.mockImplementation((request) =>
    request.args.includes("-m")
      ? Promise.resolve({ status: "completed", exitCode: 1, stdout: "", stderr: "undo denied" })
      : run(request),
  );
  const undo = await handed.value.undo(Err({ reason: "report_changed", detail: "Changed." }));
  expect(undo).toMatchObject({
    tag: "Err",
    error: {
      reason: "promotion_undo_failed",
      next: {
        decider: "super-agent",
        question:
          "How should the unconfirmed promotion renames be verified and restored before retrying?",
      },
      state: { unconfirmedRestorations: 1 },
    },
  });
  if (undo.tag === "Err") expectRefusalContext(undo.error);
  expect(git(device.checkout, "branch", "--list", "task/build")).toContain("task/build");
});
