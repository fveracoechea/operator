import { Environment } from "../environment/main.ts";

type Invocation =
  | { status: "completed"; exitCode: number; stdout: string; stderr: string }
  | { status: "unavailable"; tool: string; detail: string }
  | { status: "no-answer"; detail: string };

export const ToolInvocation = {
  /**
   * Starts a process in its own process group that outlives this one, for work that must
   * continue when the caller's pane closes. Its outcome is recorded by the process itself.
   */
  detach(input: { tool: string; args: string[]; cwd: string }) {
    const child = Bun.spawn([input.tool, ...input.args], {
      cwd: input.cwd,
      env: Environment.child(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    child.unref();
    return child.pid;
  },
  async run(input: {
    tool: string;
    args: string[];
    input?: string;
    cwd?: string;
    timeoutMs: number;
  }): Promise<Invocation> {
    // Bun.which caches the startup path unless the caller supplies PATH.
    const environment = Environment.child();
    const path = Bun.which(input.tool, { PATH: Environment.read().PATH });
    if (path === null) {
      return {
        status: "unavailable",
        tool: input.tool,
        detail: `${input.tool} is not on the path, so nothing was requested.`,
      };
    }
    const child = Bun.spawn([path, ...input.args], {
      cwd: input.cwd,
      env: environment,
      stdin: input.input === undefined ? "ignore" : new TextEncoder().encode(input.input),
      stdout: "pipe",
      stderr: "pipe",
      timeout: input.timeoutMs,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // A timeout does not prove that an external effect did not occur.
    return child.signalCode === null
      ? { status: "completed", exitCode, stdout, stderr }
      : {
          status: "no-answer",
          detail: `${input.tool} ${input.args[0] ?? ""} ended on ${child.signalCode} with no answer.`,
        };
  },
};
