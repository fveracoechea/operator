/**
 * The Operator-owned JSR client.
 * It speaks the documented management API over `fetch`, authenticates with the short-lived
 * GitHub Actions OIDC credential, and never falls back to a stored or personal token.
 */

const OIDC_AUDIENCE = "jsr";

export type JsrCredential =
  | { status: "held"; header: string }
  | { status: "unavailable"; detail: string };

export type JsrOutcome<Value> =
  | { status: "succeeded"; value: Value }
  | { status: "failed"; code: string; detail: string; httpStatus: number | null }
  | { status: "uncertain"; detail: string };

export type PublishingTask = { id: string; status: string; error: string | null };

type Environment = Record<string, string | undefined>;

/**
 * Reads the short-lived credential the runner offers.
 * No other source is consulted, so a missing credential stops the publication rather than
 * reaching for a personal token.
 */
export async function readOidcCredential(request: {
  environment: Environment;
  fetch: typeof fetch;
}): Promise<JsrCredential> {
  const url = request.environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = request.environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (url === undefined || token === undefined) {
    return {
      status: "unavailable",
      detail:
        "This runner offers no GitHub Actions OIDC credential, and Operator uses no other one.",
    };
  }

  let response: Response;
  try {
    response = await request.fetch(`${url}&audience=${OIDC_AUDIENCE}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch (error) {
    return { status: "unavailable", detail: `The OIDC credential was refused: ${String(error)}` };
  }

  if (!response.ok) {
    return {
      status: "unavailable",
      detail: `The OIDC credential request answered ${response.status}.`,
    };
  }

  const body: unknown = await response.json();
  const value =
    body !== null && typeof body === "object" && "value" in body ? body.value : undefined;
  return typeof value === "string" && value.length > 0
    ? { status: "held", header: `githuboidc ${value}` }
    : { status: "unavailable", detail: "The OIDC answer carried no token." };
}

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

function readTask(body: unknown): PublishingTask | null {
  if (body === null || typeof body !== "object" || !("id" in body) || !("status" in body)) {
    return null;
  }

  const error = "error" in body && body.error !== null ? JSON.stringify(body.error) : null;
  return { id: String(body.id), status: String(body.status), error };
}

export type JsrRequest = {
  api: string;
  scope: string;
  package: string;
  version: string;
  fetch: typeof fetch;
};

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

/** Sends one gzipped artifact to JSR and answers with the publishing task it started. */
export async function createVersion(
  request: JsrRequest & { credential: string; tarball: Uint8Array; config: string },
): Promise<JsrOutcome<PublishingTask>> {
  const url = `${request.api}/scopes/${request.scope}/packages/${request.package}/versions/${request.version}?config=${encodeURIComponent(request.config)}`;
  let response: Response;
  try {
    response = await request.fetch(url, {
      method: "POST",
      headers: {
        authorization: request.credential,
        "content-type": "application/octet-stream",
        accept: "application/json",
      },
      body: request.tarball.slice().buffer as ArrayBuffer,
    });
  } catch (error) {
    // The request may have reached the registry, so the effect is unknown rather than absent.
    return { status: "uncertain", detail: `JSR did not answer the publication: ${String(error)}` };
  }

  const body = await readBody(response);
  if (!response.ok) {
    return classify(
      response,
      message(body, `JSR refused the publication with ${response.status}.`),
    );
  }

  const task = readTask(body);
  return task === null
    ? { status: "uncertain", detail: "JSR accepted the publication and answered no task." }
    : { status: "succeeded", value: task };
}

/** Follows one publishing task to the end. A task that never settles stays uncertain. */
export async function awaitTask(
  request: Pick<JsrRequest, "api" | "fetch"> & {
    taskId: string;
    attempts: number;
    waitMs: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<JsrOutcome<PublishingTask>> {
  const sleep = request.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let attempt = 0; attempt < request.attempts; attempt += 1) {
    let response: Response;
    try {
      response = await request.fetch(`${request.api}/publishing_tasks/${request.taskId}`, {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      return {
        status: "uncertain",
        detail: `The publishing task could not be read: ${String(error)}`,
      };
    }

    const body = await readBody(response);
    if (!response.ok) {
      return classify(response, message(body, `JSR answered ${response.status}.`));
    }

    const task = readTask(body);
    if (task === null) {
      return {
        status: "uncertain",
        detail: "The publishing task answered a shape this release cannot read.",
      };
    }
    if (task.status === "success") {
      return { status: "succeeded", value: task };
    }
    if (task.status === "failure") {
      return {
        status: "failed",
        code: "publishing_task_failed",
        detail: task.error ?? "The publishing task failed and named no error.",
        httpStatus: null,
      };
    }

    await sleep(request.waitMs);
  }

  return {
    status: "uncertain",
    detail: `The publishing task had not settled after ${request.attempts} readings, so the publication is unfinished.`,
  };
}
