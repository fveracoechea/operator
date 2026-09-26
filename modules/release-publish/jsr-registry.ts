/**
 * JSR, as a release reaches it.
 * The plan reads the public registry API over `fetch` to learn whether a version exists. The
 * publication hands a staged copy of the artifact to the official `jsr` client, pinned in the
 * development dependencies, which authenticates with the short-lived credential the runner
 * issues to the job. See ADR 0013.
 */
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorRelease } from "../operator-release/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

export type JsrOutcome<Value> =
  | { status: "succeeded"; value: Value }
  | { status: "failed"; code: string; detail: string; httpStatus: number | null }
  | { status: "uncertain"; detail: string };

export type JsrRequest = {
  api: string;
  scope: string;
  package: string;
  version: string;
  fetch: typeof fetch;
};

function classify(response: Response, detail: string): JsrOutcome<never> {
  // The server faulted after it received the request, so the effect may still have applied.
  return response.status >= 500
    ? { status: "uncertain", detail: `JSR answered ${response.status}: ${detail}` }
    : { status: "failed", code: `http_${response.status}`, detail, httpStatus: response.status };
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function message(body: unknown, fallback: string): string {
  return body !== null && typeof body === "object" && "message" in body
    ? String(body.message)
    : fallback;
}

/** Reads whether one exact version is already published. An answer it cannot read is uncertain. */
export async function readVersion(
  request: JsrRequest,
): Promise<JsrOutcome<{ published: boolean }>> {
  const url = `${request.api}/scopes/${request.scope}/packages/${request.package}/versions/${request.version}`;
  let response: Response;
  try {
    response = await request.fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    return { status: "uncertain", detail: `JSR did not answer: ${String(error)}` };
  }

  if (response.status === 404) {
    return { status: "succeeded", value: { published: false } };
  }
  if (response.ok) {
    return { status: "succeeded", value: { published: true } };
  }

  const body = await readBody(response);
  return classify(response, message(body, `JSR answered ${response.status}.`));
}

// The client downloads its own runtime on a first run, then waits for the registry to process
// the version, so it gets far more room than a single API call.
const INSTALL_TIMEOUT_MS = 120_000;
const PUBLISH_TIMEOUT_MS = 600_000;

function tail(text: string): string {
  return text.trim().split("\n").slice(-20).join("\n");
}

/**
 * Publishes one built artifact with the official `jsr` client.
 * The client runs in a staged copy, so the artifact the release identity covers never gains a
 * file. The copy gets the exact dependencies its manifest names, because the client resolves the
 * imports of the shipped code before it sends anything, and it sends no installed dependency.
 */
export async function publishWithClient(request: {
  artifactRoot: string;
}): Promise<JsrOutcome<{ output: string }>> {
  const staging = await mkdtemp(join(tmpdir(), "operator-jsr-"));
  try {
    const root = request.artifactRoot.replace(/\/$/, "");
    for (const path of await OperatorRelease.contents({ artifactRoot: root })) {
      await Bun.write(`${staging}/${path}`, Bun.file(`${root}/${path}`), { createPath: true });
    }

    // `--no-save` writes no lock file, so the staged copy stays exactly the artifact.
    const installed = await ToolInvocation.run({
      tool: "bun",
      args: ["install", "--no-save"],
      cwd: staging,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (installed.status !== "completed" || installed.exitCode !== 0) {
      return {
        status: "failed",
        code: "dependencies_unavailable",
        detail: `The staged artifact could not install its dependencies, so nothing was sent: ${
          installed.status === "completed" ? tail(installed.stderr) : installed.detail
        }`,
        httpStatus: null,
      };
    }

    const published = await ToolInvocation.run({
      tool: "jsr",
      args: ["publish"],
      cwd: staging,
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    if (published.status === "unavailable") {
      return {
        status: "failed",
        code: "client_unavailable",
        detail: published.detail,
        httpStatus: null,
      };
    }
    if (published.status === "no-answer") {
      return { status: "uncertain", detail: published.detail };
    }

    return published.exitCode === 0
      ? { status: "succeeded", value: { output: tail(published.stdout) } }
      : {
          status: "failed",
          code: "client_failed",
          detail: `The jsr client exited ${published.exitCode}: ${tail(published.stderr || published.stdout)}`,
          httpStatus: null,
        };
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}
