export type HerdrFailure = { status: "failed"; code: string; detail: string };

/** An unfinished call. The effect may have landed, so a caller reconciles instead of repeating. */
export type HerdrUncertain = { status: "uncertain"; detail: string };

export type HerdrOutcome<Value> =
  | { status: "succeeded"; value: Value }
  | HerdrFailure
  | HerdrUncertain;

export const DEFAULT_TIMEOUT_MS = 60_000;

// Bun.which caches the startup path, so the current PATH is read on every lookup.
function herdrPath(): string | null {
  return Bun.which("herdr", { PATH: process.env.PATH ?? "" });
}

function readError(body: unknown): { code: string; message: string } | null {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return null;
  }

  const error = body.error;
  if (error === null || typeof error !== "object") {
    return { code: "herdr_error", message: JSON.stringify(error) };
  }

  const code = readString(error, "code") ?? "herdr_error";
  return { code, message: readString(error, "message") ?? code };
}

function readResult(body: unknown): unknown {
  return body !== null && typeof body === "object" && "result" in body ? body.result : undefined;
}

/**
 * Runs one Herdr command and classifies its answer.
 * Herdr reports a refused request in the body, so the body decides, not the exit status.
 * A call that never answered stays uncertain, because a timeout does not prove that
 * the effect did not happen.
 */
export async function invokeHerdr(request: {
  args: string[];
  timeoutMs?: number;
}): Promise<HerdrOutcome<unknown>> {
  const path = herdrPath();
  if (path === null) {
    return {
      status: "failed",
      code: "herdr_unavailable",
      detail: "herdr is not on the path, so nothing was requested.",
    };
  }

  const child = Bun.spawn([path, ...request.args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (child.signalCode !== null) {
    return {
      status: "uncertain",
      detail: `herdr ${request.args[0] ?? ""} ended on ${child.signalCode} with no answer.`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    // A command that answered nothing readable leaves its effect unknown, never assumed absent.
    return {
      status: "uncertain",
      detail: `herdr exited ${exitCode} with an unreadable answer: ${stderr.trim() || stdout.trim()}`,
    };
  }

  const error = readError(body);
  if (error !== null) {
    return { status: "failed", code: error.code, detail: error.message };
  }

  const result = readResult(body);
  if (result === undefined) {
    return { status: "uncertain", detail: "herdr answered with no result and no error." };
  }

  return { status: "succeeded", value: result };
}

export function readString(source: unknown, key: string): string | null {
  if (source === null || typeof source !== "object") {
    return null;
  }

  const value = Reflect.get(source, key);
  return typeof value === "string" ? value : null;
}

export function readRecords(source: unknown, key: string): unknown[] {
  if (source === null || typeof source !== "object") {
    return [];
  }

  const value = Reflect.get(source, key);
  return Array.isArray(value) ? value : [];
}
