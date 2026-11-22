import { ToolInvocation } from "../tool-invocation/main.ts";
import type { WorkerKinds } from "../worker-kinds/main.ts";

type Event = NonNullable<Parameters<typeof WorkerKinds.decidePhase>[1]>;

/** Merge owns its fresh Git observations; phase context must not preempt that lifecycle. */
export async function worktreeObservation(worktreePath: string | null, event: Event | undefined) {
  let clean = true;
  let head: string | null = null;
  if (worktreePath !== null && event !== "observe-merge") {
    const status = await ToolInvocation.run({
      tool: "git",
      args: ["status", "--porcelain", "--untracked-files=normal"],
      cwd: worktreePath,
      timeoutMs: 10000,
    });
    clean = status.status === "completed" && status.exitCode === 0 && status.stdout === "";
    const commit = await ToolInvocation.run({
      tool: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: worktreePath,
      timeoutMs: 10000,
    });
    head = commit.status === "completed" && commit.exitCode === 0 ? commit.stdout.trim() : null;
  }
  return { clean, head };
}
