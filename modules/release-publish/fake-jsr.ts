/**
 * A stand-in for JSR: its public version read, and the official `jsr` client on the path.
 * The read answers over HTTP, so the plan reaches it through `fetch` exactly as it reaches the
 * real registry. The client is a command, so the publication reaches it exactly as it reaches
 * the real one, and both read one state, so a version the client sends is a version JSR holds.
 */

const fakeClientPath = new URL("./fake-jsr-client.ts", import.meta.url).pathname;

export type JsrClientBehaviour = "publishes" | "refuses" | "publishes-then-fails";

export type JsrFakeOptions = {
  /** Versions the registry already holds, so immutability is provable. */
  published?: string[];
  /** What the official client does when it is asked to publish. */
  client?: JsrClientBehaviour;
};

export type JsrClientCall = {
  args: string[];
  cwd: string;
  version: string;
  /** Every staged file the client could publish, with the installed dependencies left out. */
  files: string[];
  /** The dependencies installed beside the staged files, which the client resolves imports from. */
  installed: string[];
};

export type JsrFakeState = { published: string[]; client: JsrClientBehaviour };

export type JsrFake = {
  api: string;
  fetch: typeof fetch;
  calls: () => Promise<JsrClientCall[]>;
  stop: () => void;
};

/**
 * Starts the fake and puts its client first on the path through `binDirectory`.
 * A later fake in the same test writes the client again, so the newest one answers.
 */
export async function startJsrFake(
  request: { directory: string; binDirectory: string } & JsrFakeOptions,
): Promise<JsrFake> {
  const statePath = `${request.directory}/state.json`;
  const callsPath = `${request.directory}/calls.jsonl`;
  const state: JsrFakeState = {
    published: request.published ?? [],
    client: request.client ?? "publishes",
  };
  await Bun.write(statePath, `${JSON.stringify(state)}\n`, { createPath: true });
  await Bun.write(callsPath, "");
  await Bun.write(
    `${request.binDirectory}/jsr`,
    `#!/bin/sh\nFAKE_JSR_DIR=${request.directory} exec bun ${fakeClientPath} "$@"\n`,
  );
  await Bun.$`chmod +x ${request.binDirectory}/jsr`.quiet();

  const server = Bun.serve({
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      const version = /^\/scopes\/([^/]+)\/packages\/([^/]+)\/versions\/(.+)$/.exec(url.pathname);
      if (version?.[3] !== undefined && incoming.method === "GET") {
        const current: JsrFakeState = await Bun.file(statePath).json();
        return current.published.includes(version[3])
          ? Response.json({ version: version[3], yanked: false })
          : Response.json({ code: "not_found", message: "Not Found" }, { status: 404 });
      }

      return Response.json({ code: "not_found", message: url.pathname }, { status: 404 });
    },
  });

  return {
    api: `http://127.0.0.1:${server.port}`,
    fetch: globalThis.fetch,
    async calls() {
      const text = await Bun.file(callsPath).text();
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    },
    stop: () => server.stop(true),
  };
}
