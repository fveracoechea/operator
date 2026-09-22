/**
 * A stand-in for the JSR management API and the GitHub Actions OIDC endpoint.
 * It answers over HTTP, so the Operator-owned client reaches it through `fetch` exactly as it
 * reaches the real registry, and the tests drive refusals, faults, and unfinished tasks.
 */

export type JsrFakeOptions = {
  /** Versions the registry already holds, so immutability is provable. */
  published?: string[];
  /** How many task readings answer `pending` before the task settles. */
  pendingReadings?: number;
  /** The status the task settles on. */
  taskOutcome?: "success" | "failure";
  /** An HTTP status the create call answers instead of accepting the version. */
  createStatus?: number;
  /** Whether the runner offers an OIDC credential at all. */
  oidc?: boolean;
};

export type JsrFake = {
  api: string;
  oidcUrl: string;
  environment: Record<string, string>;
  received: Array<{ version: string; config: string; authorization: string; bytes: number }>;
  fetch: typeof fetch;
  stop: () => void;
};

/** Starts the fake and answers the settings a client needs to reach it. */
export function startJsrFake(options: JsrFakeOptions = {}): JsrFake {
  const published = new Set(options.published ?? []);
  const received: JsrFake["received"] = [];
  const readings = new Map<string, number>();

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/oidc") {
        return options.oidc === false
          ? new Response("no credential", { status: 403 })
          : Response.json({ value: `oidc-token-for-${url.searchParams.get("audience")}` });
      }

      const version = /^\/scopes\/([^/]+)\/packages\/([^/]+)\/versions\/(.+)$/.exec(url.pathname);
      if (version?.[3] !== undefined && request.method === "GET") {
        return published.has(version[3])
          ? Response.json({ version: version[3], yanked: false })
          : Response.json({ code: "not_found", message: "Not Found" }, { status: 404 });
      }

      if (version?.[3] !== undefined && request.method === "POST") {
        if (options.createStatus !== undefined) {
          return Response.json(
            { code: "refused", message: "the registry refused this version" },
            { status: options.createStatus },
          );
        }

        received.push({
          version: version[3],
          config: url.searchParams.get("config") ?? "",
          authorization: request.headers.get("authorization") ?? "",
          bytes: (await request.arrayBuffer()).byteLength,
        });
        return Response.json({
          id: `task-${version[3]}`,
          status: "pending",
          packageScope: version[1],
          packageName: version[2],
          packageVersion: version[3],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      }

      const task = /^\/publishing_tasks\/(.+)$/.exec(url.pathname);
      if (task?.[1] !== undefined) {
        const seen = (readings.get(task[1]) ?? 0) + 1;
        readings.set(task[1], seen);
        const settled = seen > (options.pendingReadings ?? 0);
        const outcome = options.taskOutcome ?? "success";
        if (settled && outcome === "success") {
          published.add(task[1].replace("task-", ""));
        }

        return Response.json({
          id: task[1],
          status: settled ? outcome : "processing",
          error:
            settled && outcome === "failure" ? { code: "bad", message: "the task failed" } : null,
          packageScope: "fveracoechea",
          packageName: "operator",
          packageVersion: task[1].replace("task-", ""),
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      }

      return Response.json({ code: "not_found", message: url.pathname }, { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    api: base,
    oidcUrl: `${base}/oidc`,
    environment: {
      ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?x=1`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
    },
    received,
    fetch: globalThis.fetch,
    stop: () => server.stop(true),
  };
}
