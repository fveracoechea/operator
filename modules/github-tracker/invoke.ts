import { ToolInvocation } from "../tool-invocation/main.ts";

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
  const message = ToolInvocation.text(body, "message");
  return message === null || message.length === 0 ? fallback : message;
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
  timeoutMs: number;
}): Promise<GithubOutcome<GithubResponse>> {
  const invoked = await ToolInvocation.run({
    tool: "gh",
    args: ["api", "--include", ...request.args],
    input: request.input,
    timeoutMs: request.timeoutMs,
  });
  if (invoked.status === "unavailable") {
    return {
      status: "failed",
      code: "github_unavailable",
      detail: invoked.detail,
      httpStatus: null,
    };
  }
  if (invoked.status === "no-answer") {
    return { status: "uncertain", detail: invoked.detail };
  }

  const split = splitResponse(invoked.stdout);
  if (split === null) {
    // A call that answered nothing readable leaves its effect unknown, never assumed absent.
    return {
      status: "uncertain",
      detail: `gh api answered with no readable status: ${invoked.stderr.trim() || invoked.stdout.trim()}`,
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
      detail: `GitHub answered ${split.httpStatus}: ${messageOf(body, invoked.stderr.trim())}`,
    };
  }

  if (split.httpStatus >= 400) {
    return {
      status: "failed",
      code: `http_${split.httpStatus}`,
      detail: messageOf(body, invoked.stderr.trim() || `GitHub refused with ${split.httpStatus}.`),
      httpStatus: split.httpStatus,
    };
  }

  return { status: "succeeded", value: { httpStatus: split.httpStatus, body } };
}
