export type GithubFailure = {
  status: "failed";
  code: string;
  detail: string;
  httpStatus: number | null;
};

/** An unfinished call. The effect may have landed, so a caller reconciles instead of repeating. */
export type GithubUncertain = { status: "uncertain"; detail: string };

export type GithubOutcome<Value> =
  | { status: "succeeded"; value: Value }
  | GithubFailure
  | GithubUncertain;

export type GithubResponse = { httpStatus: number; body: unknown };

// Every caller states its own bound; this is the floor for one that does not.
const DEFAULT_TIMEOUT_MS = 60_000;

// Bun.which caches the startup path, so the current PATH is read on every lookup.
function ghPath(): string | null {
  return Bun.which("gh", { PATH: process.env.PATH ?? "" });
}

/** Splits the `--include` answer into its status line and its body. */
function splitResponse(stdout: string): { httpStatus: number; bodyText: string } | null {
  const separator = stdout.indexOf("\r\n\r\n");
  const boundary = separator === -1 ? stdout.indexOf("\n\n") : separator;
  if (boundary === -1) {
    return null;
  }

  const head = stdout.slice(0, boundary);
  const statusLine = head.split(/\r?\n/)[0] ?? "";
  const match = /^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine);
  if (match?.[1] === undefined) {
    return null;
  }

  return {
    httpStatus: Number(match[1]),
    bodyText: stdout.slice(boundary + (separator === -1 ? 2 : 4)),
  };
}

function messageOf(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const message = Reflect.get(body, "message");
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return fallback;
}

/**
 * Runs one `gh api` call and classifies its answer by the HTTP status GitHub returned.
 * A request GitHub refused is a definite failure, because the server answered.
 * A call that never answered, or answered with a server fault, stays uncertain: a timeout does
 * not prove that the effect did not happen.
 */
export async function callGithub(request: {
  args: string[];
  input?: string;
  timeoutMs?: number;
}): Promise<GithubOutcome<GithubResponse>> {
  const path = ghPath();
  if (path === null) {
    return {
      status: "failed",
      code: "github_unavailable",
      detail: "gh is not on the path, so nothing was requested.",
      httpStatus: null,
    };
  }

  // A request body travels on standard input, so exact content reaches GitHub unchanged.
  const child = Bun.spawn([path, "api", "--include", ...request.args], {
    stdin: request.input === undefined ? "ignore" : new TextEncoder().encode(request.input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const [, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (child.signalCode !== null) {
    return {
      status: "uncertain",
      detail: `gh api ended on ${child.signalCode} with no answer.`,
    };
  }

  const split = splitResponse(stdout);
  if (split === null) {
    // A call that answered nothing readable leaves its effect unknown, never assumed absent.
    return {
      status: "uncertain",
      detail: `gh api answered with no readable status: ${stderr.trim() || stdout.trim()}`,
    };
  }

  let body: unknown;
  try {
    body = split.bodyText.trim() === "" ? null : JSON.parse(split.bodyText);
  } catch (error) {
    return {
      status: "uncertain",
      detail: `gh api answered ${split.httpStatus} with a body this release cannot read: ${String(error)}`,
    };
  }

  if (split.httpStatus >= 500) {
    // The server faulted after it received the request, so the effect may still have applied.
    return {
      status: "uncertain",
      detail: `GitHub answered ${split.httpStatus}: ${messageOf(body, stderr.trim())}`,
    };
  }

  if (split.httpStatus >= 400) {
    return {
      status: "failed",
      code: `http_${split.httpStatus}`,
      detail: messageOf(body, stderr.trim() || `GitHub refused with ${split.httpStatus}.`),
      httpStatus: split.httpStatus,
    };
  }

  return { status: "succeeded", value: { httpStatus: split.httpStatus, body } };
}

export function readString(source: unknown, key: string): string | null {
  if (source === null || typeof source !== "object") {
    return null;
  }

  const value = Reflect.get(source, key);
  return typeof value === "string" ? value : null;
}

export function readNumber(source: unknown, key: string): number | null {
  if (source === null || typeof source !== "object") {
    return null;
  }

  const value = Reflect.get(source, key);
  return typeof value === "number" ? value : null;
}

export function readRecord(source: unknown, key: string): unknown {
  return source !== null && typeof source === "object" ? Reflect.get(source, key) : undefined;
}
