import { afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { PrEntry } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});

test("ready entry observes the placed worktree and returns one current receipt", async () => {
  setSystemTime(new Date("2026-11-20T12:00:00.000Z"));
  const run = spyOn(ToolInvocation, "run").mockImplementation(async ({ args }) => ({
    status: "completed",
    exitCode: 0,
    stdout: args.includes("status") ? "" : "pushed\n",
    stderr: "",
  }));
  expect(
    await PrEntry.prepare({
      worktree: "/placed",
      internalReview: false,
      draft: false,
      head: "pushed",
    }),
  ).toMatchObject({
    tag: "Ok",
    value: {
      review: false,
      readiness: { head: "pushed", at: "2026-11-20T12:00:00.000Z", note: null, dispositions: [] },
    },
  });
  expect(run.mock.calls.map(([input]) => input)).toEqual([
    {
      tool: "git",
      args: ["-C", "/placed", "status", "--porcelain", "--untracked-files=normal"],
      timeoutMs: 10000,
    },
    { tool: "git", args: ["-C", "/placed", "rev-parse", "--verify", "HEAD"], timeoutMs: 10000 },
  ]);
});

test.each([true, false])("draft entry review=%s creates no readiness", async (internalReview) => {
  const run = spyOn(ToolInvocation, "run").mockImplementation(async ({ args }) => ({
    status: "completed",
    exitCode: 0,
    stdout: args.includes("status") ? "" : "pushed",
    stderr: "",
  }));
  expect(
    await PrEntry.prepare({ worktree: "/placed", internalReview, draft: true, head: "pushed" }),
  ).toMatchObject({ tag: "Ok", value: { review: internalReview, readiness: null } });
  expect(run).toHaveBeenCalledTimes(internalReview ? 2 : 0);
});

test.each([
  ["?? local.txt\n", "pushed", "pr_worktree_unclean"],
  ["", "local-only", "pr_worktree_unsynced"],
  [null, "pushed", "pr_worktree_unclean"],
  ["", null, "pr_worktree_unsynced"],
] as const)("ready entry refuses status=%s head=%s", async (status, head, reason) => {
  spyOn(ToolInvocation, "run").mockImplementation(async ({ args }) => {
    const output = args.includes("status") ? status : head;
    return {
      status: "completed",
      exitCode: output === null ? 1 : 0,
      stdout: output ?? "",
      stderr: "",
    };
  });
  expect(
    await PrEntry.prepare({
      worktree: "/placed",
      internalReview: false,
      draft: false,
      head: "pushed",
    }),
  ).toMatchObject({ tag: "Err", error: { reason } });
});

test("observations preserve unexpected causes and classify known IO failures", async () => {
  const cause = new Error("git defect", { cause: { original: true } });
  const run = spyOn(ToolInvocation, "run").mockRejectedValue(cause);
  const result = await PrEntry.worktreeFacts("/placed");
  expect(result.tag).toBe("Defect");
  if (result.tag === "Defect") expect(result.cause).toBe(cause);
  run.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  expect(await PrEntry.worktreeFacts("/placed")).toMatchObject({
    tag: "Err",
    error: { reason: "pr_io_failed", state: { code: "ENOENT" } },
  });
});
