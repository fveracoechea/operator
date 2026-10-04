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

/** One Git reading, or why it could not be made. */
type GitReading =
  | { status: "read"; value: string; bytes: Uint8Array; exitCode: number; stderr: string }
  | { status: "unread"; detail: string };

/**
 * Why one Git call gave no answer. A timed-out call still has the exit code and the error text
 * that it left, so a caller can word it as before.
 */
type GitFailure =
  | { kind: "unavailable"; args: string[]; detail: string }
  | { kind: "no-answer"; args: string[]; signal: string; exitCode: number; stderr: string }
  | { kind: "exit"; args: string[]; exitCode: number; stderr: string };

type GitRequest = {
  repoRoot: string;
  args: string[];
  input?: string;
  /** Keeps the output byte for byte, as a commit object or a NUL-separated list must be. */
  raw?: boolean;
  timeoutMs?: number;
  /** Each exit code that is an answer, or `any`. Exit 0 is the only one by default. */
  answers?: number[] | "any";
  /** Words the detail of a failure. `ToolInvocation.gitFailure` is the default. */
  failed?: (failure: GitFailure) => string;
};

/**
 * The checkout config can name a command that Git runs, and a planted one waits for the person,
 * so every call turns off the file system monitor. It takes no optional lock, so a read never
 * writes the index of the checkout either (ADR 0018).
 */
const GIT_GUARD = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

type Spawned =
  | { status: "completed"; exitCode: number; stdout: Uint8Array; stderr: string }
  | { status: "unavailable"; tool: string; detail: string }
  | { status: "no-answer"; signal: string; exitCode: number; stderr: string };

async function spawn(request: {
  tool: string;
  args: string[];
  input?: string;
  cwd?: string;
  timeoutMs: number;
}): Promise<Spawned> {
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
    cwd: request.cwd,
    stdin: request.input === undefined ? "ignore" : new TextEncoder().encode(request.input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeoutMs,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
  ]);

  return child.signalCode === null
    ? { status: "completed", exitCode, stdout, stderr }
    : { status: "no-answer", signal: child.signalCode, exitCode, stderr };
}

export const ToolInvocation = {
  /** Runs one tool and reports what it did, never what its output means. */
  async run(request: {
    tool: string;
    args: string[];
    input?: string;
    cwd?: string;
    timeoutMs: number;
  }): Promise<Invocation> {
    const spawned = await spawn(request);
    if (spawned.status === "no-answer") {
      return {
        status: "no-answer",
        detail: `${request.tool} ${request.args[0] ?? ""} ended on ${spawned.signal} with no answer.`,
      };
    }
    return spawned.status === "completed"
      ? { ...spawned, stdout: new TextDecoder().decode(spawned.stdout) }
      : spawned;
  },

  /**
   * Runs one Git command in one repository, always with the guard of ADR 0018.
   * `merge-base --is-ancestor`, `merge-tree`, and `config --get-regexp` answer with exit 1, so a
   * caller names that exit in `answers` and reads the exit code. `bytes` holds the exact bytes
   * of the output, as a committed file must be read.
   */
  async git(request: GitRequest): Promise<GitReading> {
    const call: Parameters<typeof spawn>[0] = {
      tool: "git",
      args: [...GIT_GUARD, "-C", request.repoRoot, ...request.args],
      timeoutMs: request.timeoutMs ?? 30_000,
    };
    if (request.input !== undefined) {
      call.input = request.input;
    }
    const spawned = await spawn(call);
    const failed = request.failed ?? ToolInvocation.gitFailure;
    const { args } = request;
    if (spawned.status === "unavailable") {
      return {
        status: "unread",
        detail: failed({ kind: "unavailable", args, detail: spawned.detail }),
      };
    }
    if (spawned.status === "no-answer") {
      return {
        status: "unread",
        detail: failed({
          kind: "no-answer",
          args,
          signal: spawned.signal,
          exitCode: spawned.exitCode,
          stderr: spawned.stderr,
        }),
      };
    }
    const { exitCode, stdout, stderr } = spawned;
    const answers = request.answers ?? [0];
    if (answers !== "any" && !answers.includes(exitCode)) {
      return { status: "unread", detail: failed({ kind: "exit", args, exitCode, stderr }) };
    }
    const text = new TextDecoder().decode(stdout);
    return {
      status: "read",
      value: request.raw === true ? text : text.trim(),
      bytes: stdout,
      exitCode,
      stderr,
    };
  },

  /**
   * Words one Git failure as the callers of `run` worded it when each Git call started with
   * `-C`, so their details stay the same.
   */
  gitFailure(failure: GitFailure): string {
    if (failure.kind === "unavailable") {
      return failure.detail;
    }
    return failure.kind === "no-answer"
      ? `git -C ended on ${failure.signal} with no answer.`
      : `git ${failure.args[0] ?? ""} exited ${failure.exitCode}: ${failure.stderr.trim()}`;
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
