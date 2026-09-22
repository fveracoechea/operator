/**
 * One run of an external command-line tool.
 * A tool that is not installed requested nothing, so its absence is separated from a tool that
 * answered. A call that never answered stays unfinished, because a timeout does not prove that
 * the effect did not happen.
 */
type Completed = { status: "completed"; exitCode: number; stdout: string; stderr: string };

type Invocation =
  | Completed
  | { status: "unavailable"; tool: string; detail: string }
  | { status: "no-answer"; detail: string };

export const ToolInvocation = {
  /** Runs one tool and reports what it did, never what its output means. */
  async run(request: {
    tool: string;
    args: string[];
    input?: string;
    timeoutMs: number;
  }): Promise<Invocation> {
    // Bun.which caches the startup path, so the current PATH is read on every lookup.
    const path = Bun.which(request.tool, { PATH: process.env.PATH ?? "" });
    if (path === null) {
      return {
        status: "unavailable",
        tool: request.tool,
        detail: `${request.tool} is not on the path, so nothing was requested.`,
      };
    }

    // A request body travels on standard input, so exact content reaches the tool unchanged.
    const child = Bun.spawn([path, ...request.args], {
      stdin: request.input === undefined ? "ignore" : new TextEncoder().encode(request.input),
      stdout: "pipe",
      stderr: "pipe",
      timeout: request.timeoutMs,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return child.signalCode === null
      ? { status: "completed", exitCode, stdout, stderr }
      : {
          status: "no-answer",
          detail: `${request.tool} ${request.args[0] ?? ""} ended on ${child.signalCode} with no answer.`,
        };
  },

  /** Reads one string field of an answer this release cannot otherwise trust. */
  text(source: unknown, key: string): string | null {
    if (source === null || typeof source !== "object") {
      return null;
    }

    const value = Reflect.get(source, key);
    return typeof value === "string" ? value : null;
  },

  /** Reads one whole-number field of an answer. */
  number(source: unknown, key: string): number | null {
    if (source === null || typeof source !== "object") {
      return null;
    }

    const value = Reflect.get(source, key);
    return typeof value === "number" ? value : null;
  },

  /** Reads one nested record of an answer, without asserting its shape. */
  record(source: unknown, key: string): unknown {
    return source !== null && typeof source === "object" ? Reflect.get(source, key) : undefined;
  },

  /** Reads one list field of an answer. A field that is not a list reads as no entries. */
  list(source: unknown, key: string): unknown[] {
    if (source === null || typeof source !== "object") {
      return [];
    }

    const value = Reflect.get(source, key);
    return Array.isArray(value) ? value : [];
  },
};
