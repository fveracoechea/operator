// Bun has no file descriptor API, so one open file takes both output streams of a command.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { ContentIdentity } from "../content-identity/main.ts";
import { CrewState } from "../crew-state/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

/** Where the output of each gate command is kept, outside the crew state (ADR 0021). */
const STORE = ".operator/local/gate-runs";

type Outcome = {
  outcome: "passed" | "failed";
  exitCode: number | null;
  reason: "timed-out" | null;
};

async function git(checkout: string, args: string[]) {
  const invoked = await ToolInvocation.run({
    tool: "git",
    args: ["-C", checkout, ...args],
    timeoutMs: 120_000,
  });
  return invoked.status === "completed" && invoked.exitCode === 0
    ? { ok: true as const, stdout: invoked.stdout.trim() }
    : {
        ok: false as const,
        detail:
          invoked.status === "completed"
            ? `git ${args.join(" ")} exited ${invoked.exitCode}: ${invoked.stderr.trim()}`
            : invoked.detail,
      };
}

/**
 * Detaches HEAD at the commit of the key and removes every file that is not in its tree,
 * ignored files too, so no stale cache or build output can change an outcome.
 */
async function prepare(checkout: string, commit: string): Promise<string | null> {
  for (const args of [
    ["checkout", "--quiet", "--detach", "--force", commit],
    ["clean", "-ffdx", "--quiet"],
  ]) {
    const done = await git(checkout, args);
    if (!done.ok) return done.detail;
  }
  const head = await git(checkout, ["rev-parse", "HEAD"]);
  if (!head.ok) return head.detail;
  if (head.stdout !== commit) return `The gate checkout is at ${head.stdout}, not at ${commit}.`;
  const status = await git(checkout, ["status", "--porcelain", "--ignored"]);
  if (!status.ok) return status.detail;
  return status.stdout === "" ? null : `The gate checkout still holds files: ${status.stdout}`;
}

/**
 * Runs one command from its arguments with no shell. The exit status comes from the process,
 * and a command over its time limit is killed with its process group and fails as `timed-out`.
 */
async function runCommand(request: {
  checkout: string;
  argv: string[];
  timeoutSeconds: number;
  output: string;
}): Promise<Outcome> {
  const fd = openSync(request.output, "w");
  try {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(request.argv, {
        cwd: request.checkout,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        detached: true,
      });
    } catch (error) {
      writeSync(fd, `The command could not start: ${String(error)}\n`);
      return { outcome: "failed", exitCode: null, reason: null };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, request.timeoutSeconds * 1000);
    const exitCode = await child.exited;
    clearTimeout(timer);

    if (timedOut) {
      return { outcome: "failed", exitCode: null, reason: "timed-out" };
    }
    return { outcome: exitCode === 0 ? "passed" : "failed", exitCode, reason: null };
  } finally {
    closeSync(fd);
  }
}

type StatusOf<Call extends (request: never) => Promise<{ result: { status: string } }>> = Awaited<
  ReturnType<Call>
>["result"]["status"];

/**
 * How one runner ends: the state its run reached, or the crew-state status that stopped it from
 * reading or writing its run.
 */
type RunnerStatus =
  | "running"
  | "passed"
  | "failed"
  | "stopped"
  | StatusOf<typeof CrewState.gateRun>
  | Exclude<StatusOf<typeof CrewState.beginGateRun>, "recorded">
  | Exclude<StatusOf<typeof CrewState.stopGateRun>, "recorded">
  | Exclude<StatusOf<typeof CrewState.recordGateCommand>, "recorded">;

/**
 * The Operator runner of one gate run (ADR 0021). It runs in the pane of the gate checkout, and
 * it records each outcome itself, so no outcome is ever read from pane text. Every write runs
 * under the owner that started the run, so a takeover stops it at its next write.
 */
export const GateRunner = {
  async run(request: {
    projectRoot: string;
    runId: string;
    /** The command that wakes an idle Operator, because a plain command fires no agent event. */
    wakeCommand: string[];
  }): Promise<{ status: RunnerStatus; lines: string[] }> {
    const lines: string[] = [];
    const finish = async (status: RunnerStatus) => {
      const wake = Bun.spawn(request.wakeCommand, {
        cwd: request.projectRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [message] = await Promise.all([new Response(wake.stdout).text(), wake.exited]);
      lines.push(`Wake check: ${message.trim() || "no answer"}`);
      return { status, lines };
    };

    const shown = await CrewState.gateRun({
      projectRoot: request.projectRoot,
      runId: request.runId,
    });
    if (shown.result.status !== "reported" || shown.result.checkoutPath === null) {
      lines.push(`Gate run ${request.runId} cannot be read: ${shown.result.status}.`);
      return finish(shown.result.status);
    }
    const { run, checkoutPath } = shown.result;

    const begun = await CrewState.beginGateRun(request);
    if (begun.result.status !== "recorded") {
      lines.push(`The runner may not write gate run ${run.runId}: ${begun.result.status}.`);
      return finish(begun.result.status);
    }

    const prepared = await prepare(checkoutPath, run.commit);
    if (prepared !== null) {
      const stopped = await CrewState.stopGateRun({ ...request, detail: prepared });
      lines.push(prepared);
      return finish(stopped.result.status === "recorded" ? "stopped" : stopped.result.status);
    }

    const folder = `${STORE}/${run.runId}`;
    mkdirSync(`${request.projectRoot}/${folder}`, { recursive: true });
    for (const [position, command] of run.commands.entries()) {
      const outputPath = `${folder}/${position}-${command.name.replaceAll(/[^A-Za-z0-9._-]/g, "-")}.log`;
      const absolute = `${request.projectRoot}/${outputPath}`;
      lines.push(`Running ${command.name}: ${command.argv.join(" ")}`);
      const outcome = await runCommand({
        checkout: checkoutPath,
        argv: command.argv,
        timeoutSeconds: command.timeoutSeconds,
        output: absolute,
      });
      const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer());
      const recorded = await CrewState.recordGateCommand({
        ...request,
        command: {
          position,
          ...outcome,
          outputPath,
          outputIdentity: ContentIdentity.ofBytes(bytes),
        },
      });
      if (recorded.result.status !== "recorded") {
        lines.push(`The runner may not record ${command.name}: ${recorded.result.status}.`);
        return finish(recorded.result.status);
      }
      lines.push(
        `${command.name}: ${outcome.outcome}${outcome.reason === null ? "" : ` (${outcome.reason})`}`,
      );
      if (recorded.result.run.state !== "running") {
        return finish(recorded.result.run.state);
      }
    }
    return finish("running");
  },
};
