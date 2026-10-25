import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { readVersion } from "./jsr-registry.ts";
import { z } from "zod";

const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-jsr-registry-${crypto.randomUUID()}`;
afterEach(async () => {
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
    new Response(child.stdout).json().then((value: unknown) => z.unknown().parse(value)),
  ]);
  expect(code).toBe(0);
  expect(output).toMatchObject({ status: "failed", code: "dependencies_unavailable" });
  expect(await Bun.file(`${root}/artifact/file`).text()).toBe("unchanged");
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root }))).toEqual([
    "artifact/file",
  ]);
});
