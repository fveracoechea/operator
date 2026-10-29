import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no recursive directory removal or chmod API.
import { chmod, rm } from "node:fs/promises";
import { checkWithClient, publishWithClient, readVersion } from "./jsr-registry.ts";
import { z } from "zod";

const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-jsr-registry-${crypto.randomUUID()}`;
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test("version reads distinguish present, absent, refused, and uncertain registry answers", async () => {
  let status = 200;
  const urls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      urls.push(new URL(request.url).pathname);
      return Response.json({ message: "registry answer" }, { status });
    },
  });
  const input = {
    api: `http://127.0.0.1:${server.port}`,
    scope: "owner",
    package: "operator",
    version: "1.0.0",
    fetch: globalThis.fetch,
  };
  try {
    expect(await readVersion(input)).toEqual({ status: "succeeded", value: { published: true } });
    status = 404;
    expect(await readVersion(input)).toEqual({ status: "succeeded", value: { published: false } });
    status = 403;
    expect(await readVersion(input)).toMatchObject({ status: "failed", httpStatus: 403 });
    status = 500;
    expect((await readVersion(input)).status).toBe("uncertain");
    expect(urls).toEqual(
      Array.from({ length: 4 }, () => "/scopes/owner/packages/operator/versions/1.0.0"),
    );
  } finally {
    await server.stop(true);
  }
});

test("a missing dependency installer prevents publication and removes only its staging copy", async () => {
  await Bun.write(`${root}/artifact/file`, "unchanged", { createPath: true });
  const modulePath = new URL("./jsr-registry.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { publishWithClient } = await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify(await publishWithClient({ artifactRoot: ${JSON.stringify(`${root}/artifact`)} })));`,
    ],
    {
      env: {
        ...Environment.child(),
        PATH: `${root}/no-tools`,
        HOME: root,
        TMPDIR: root,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_STATE_HOME: `${root}/state`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).json().then((value) => z.unknown().parse(value)),
  ]);
  expect(code).toBe(0);
  expect(output).toMatchObject({ status: "failed", code: "dependencies_unavailable" });
  expect(await Bun.file(`${root}/artifact/file`).text()).toBe("unchanged");
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root }))).toEqual([
    "artifact/file",
  ]);
});

test("a refusal carries the registry's message, or only the status when the body has none", async () => {
  const bodies = [
    Response.json({ message: "scope is not yours" }, { status: 403 }),
    Response.json({ other: "field" }, { status: 403 }),
    new Response("not json", { status: 403 }),
  ];
  const server = Bun.serve({ port: 0, fetch: () => bodies.shift() ?? new Response(null) });
  const input = {
    api: `http://127.0.0.1:${server.port}`,
    scope: "owner",
    package: "operator",
    version: "1.0.0",
    fetch: globalThis.fetch,
  };
  try {
    for (const detail of ["scope is not yours", "JSR answered 403.", "JSR answered 403."])
      expect(await readVersion(input)).toEqual({
        status: "failed",
        code: "http_403",
        detail,
        httpStatus: 403,
      });
  } finally {
    await server.stop(true);
  }
});

/** A controlled Bun that installs nothing, and a controlled client that records its call. */
async function controlledTools() {
  await Bun.write(`${root}/tools/bun`, "#!/bin/sh\nexit 0\n", { createPath: true });
  await Bun.write(
    `${root}/tools/jsr`,
    `#!/bin/sh\necho "$*" > ${JSON.stringify(`${root}/args`)}\n/bin/ls > ${JSON.stringify(`${root}/staged`)}\necho "client output"\n`,
  );
  await chmod(`${root}/tools/bun`, 0o755);
  await chmod(`${root}/tools/jsr`, 0o755);
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: `${root}/tools` });
}

test("publication sends the staged artifact and the check only simulates it", async () => {
  await Bun.write(`${root}/artifact/jsr.json`, "{}", { createPath: true });
  await controlledTools();
  for (const [run, args] of [
    [publishWithClient, "publish"],
    [checkWithClient, "publish --dry-run"],
  ] as const) {
    expect(await run({ artifactRoot: `${root}/artifact/` })).toEqual({
      status: "succeeded",
      value: { output: "client output" },
    });
    expect((await Bun.file(`${root}/args`).text()).trim()).toBe(args);
    expect((await Bun.file(`${root}/staged`).text()).trim()).toBe("jsr.json");
  }
});
