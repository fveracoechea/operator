import { ToolInvocation } from "../tool-invocation/main.ts";

export type HerdrFailure = { status: "failed"; code: string; detail: string };

/** An unfinished call. The effect may have landed, so a caller reconciles instead of repeating. */
export type HerdrUncertain = { status: "uncertain"; detail: string };

export type HerdrOutcome<Value> =
  | { status: "succeeded"; value: Value }
  | HerdrFailure
  | HerdrUncertain;

function readError(body: unknown): { code: string; message: string } | null {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return null;
  }

  const error = body.error;
  if (error === null || typeof error !== "object") {
    return { code: "herdr_error", message: JSON.stringify(error) };
  }

  const code = ToolInvocation.text(error, "code") ?? "herdr_error";
  return { code, message: ToolInvocation.text(error, "message") ?? code };
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
  timeoutMs: number;
}): Promise<HerdrOutcome<unknown>> {
  const invoked = await ToolInvocation.run({
    tool: "herdr",
    args: request.args,
    timeoutMs: request.timeoutMs,
  });
  if (invoked.status === "unavailable") {
    return { status: "failed", code: "herdr_unavailable", detail: invoked.detail };
  }
  if (invoked.status === "no-answer") {
    return { status: "uncertain", detail: invoked.detail };
  }

  let body: unknown;
  try {
    body = JSON.parse(invoked.stdout);
  } catch {
    // A command that answered nothing readable leaves its effect unknown, never assumed absent.
    return {
      status: "uncertain",
      detail: `herdr exited ${invoked.exitCode} with an unreadable answer: ${invoked.stderr.trim() || invoked.stdout.trim()}`,
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
