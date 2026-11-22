import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { worktreeObservation } from "./worktree-observation.ts";

type Invocation = Awaited<ReturnType<typeof ToolInvocation.run>>;

afterEach(() => mock.restore());

test("a worker without a worktree needs no Git observation", async () => {
  const run = spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  expect(await worktreeObservation(null, undefined)).toEqual({ clean: true, head: null });
  expect(run).not.toHaveBeenCalled();
});

test("merge leaves all Git observations to the canonical merge lifecycle", async () => {
  const run = spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  expect(await worktreeObservation("/worker", "observe-merge")).toEqual({
    clean: true,
    head: null,
  });
  expect(run).not.toHaveBeenCalled();
});

test.each([undefined, "associate", "round", "ready", "wait", "submit", "resume"] as const)(
  "phase event %s observes only the recorded worktree with bounded read-only commands",
  async (event) => {
    const run = spyOn(ToolInvocation, "run")
      .mockResolvedValueOnce({ status: "completed", exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        status: "completed",
        exitCode: 0,
        stdout: " \thead-123\n ",
        stderr: "",
      });
    expect(await worktreeObservation("/recorded/worker", event)).toEqual({
      clean: true,
      head: "head-123",
    });
    expect(run.mock.calls).toEqual([
      [
        {
          tool: "git",
          args: ["status", "--porcelain", "--untracked-files=normal"],
          cwd: "/recorded/worker",
          timeoutMs: 10000,
        },
      ],
      [
        {
          tool: "git",
          args: ["rev-parse", "--verify", "HEAD"],
          cwd: "/recorded/worker",
          timeoutMs: 10000,
        },
      ],
    ]);
  },
);

test.each([
  { status: "completed", exitCode: 0, stdout: "?? new.txt\n", stderr: "" },
  { status: "completed", exitCode: 0, stdout: " ", stderr: "" },
  { status: "completed", exitCode: 1, stdout: "", stderr: "failed" },
  { status: "unavailable", tool: "git", detail: "missing", exitCode: 0, stdout: "" },
  { status: "no-answer", detail: "interrupted", exitCode: 0, stdout: "" },
] satisfies (Invocation & { exitCode?: number; stdout?: string })[])(
  "status %j cannot prove cleanliness, but does not suppress the HEAD observation",
  async (status) => {
    const run = spyOn(ToolInvocation, "run").mockResolvedValueOnce(status).mockResolvedValueOnce({
      status: "completed",
      exitCode: 0,
      stdout: "head-456\n",
      stderr: "",
    });
    expect(await worktreeObservation("/worker", "associate")).toEqual({
      clean: false,
      head: "head-456",
    });
    expect(run).toHaveBeenCalledTimes(2);
  },
);

test.each([
  { status: "completed", exitCode: 1, stdout: "stale-head", stderr: "failed" },
  { status: "unavailable", tool: "git", detail: "missing", exitCode: 0, stdout: "stale-head" },
  { status: "no-answer", detail: "interrupted", exitCode: 0, stdout: "stale-head" },
] satisfies (Invocation & { exitCode?: number; stdout?: string })[])(
  "HEAD failure %j remains unknown without changing cleanliness",
  async (head) => {
    const run = spyOn(ToolInvocation, "run")
      .mockResolvedValueOnce({ status: "completed", exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce(head);
    expect(await worktreeObservation("/worker", "ready")).toEqual({ clean: true, head: null });
    expect(run).toHaveBeenCalledTimes(2);
  },
);

test("a tool defect keeps its original cause and never starts a later observation", async () => {
  const cause = new Error("original observation defect");
  const run = spyOn(ToolInvocation, "run").mockRejectedValue(cause);
  await expect(worktreeObservation("/worker", "associate")).rejects.toBe(cause);
  expect(run).toHaveBeenCalledTimes(1);
});
