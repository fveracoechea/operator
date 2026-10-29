import { afterEach, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no chmod or recursive directory removal API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";

const roots: string[] = [];
const modulePath = new URL("./call.ts", import.meta.url).pathname;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each([
  {
    response: 'HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n{"value":1}',
    status: "succeeded",
  },
  { response: 'HTTP/2.0 404 Error\n\n{"message":"missing"}', status: "failed", detail: "missing" },
  {
    response: 'HTTP/2.0 404 Error\n\n{"message":""}',
    stderr: " denied \n",
    status: "failed",
    detail: "denied",
  },
  {
    response: "HTTP/2.0 404 Error\n\n",
    status: "failed",
    detail: "GitHub refused with 404.",
  },
  {
    response: 'HTTP/2.0 500 Error\n\n{"message":"fault"}',
    status: "uncertain",
    detail: "GitHub answered 500: fault",
  },
  {
    response: "HTTP/2.0 502 Error\n\n[]",
    stderr: " gateway \n",
    status: "uncertain",
    detail: "GitHub answered 502: gateway",
  },
  { response: "HTTP/2.0 200 OK\n\nnot JSON", status: "uncertain" },
  { response: "not HTTP", status: "uncertain" },
])(
  "classifies the external GitHub answer as $status",
  async ({ response, stderr = "", status, detail }) => {
    const root = `${Environment.read().TMPDIR ?? "/tmp"}/operator-github-api-${crypto.randomUUID()}`;
    roots.push(root);
    await Bun.write(
      `${root}/bin/gh`,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(`${root}/call.json`)}, JSON.stringify({ args: Bun.argv.slice(2), input: await Bun.stdin.text() }));\nprocess.stdout.write(${JSON.stringify(response)});\nprocess.stderr.write(${JSON.stringify(stderr)});\n`,
      { createPath: true },
    );
    await chmod(`${root}/bin/gh`, 0o755);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { callGithub } = await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify(await callGithub({ args: ["repos/test/repo", "--input", "-"], input: "exact", timeoutMs: 5000 })));`,
      ],
      {
        env: {
          ...Environment.child(),
          PATH: `${root}/bin`,
          HOME: root,
          XDG_CONFIG_HOME: `${root}/config`,
          XDG_STATE_HOME: `${root}/state`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).json().then((value) =>
        z
          .looseObject({
            status: z.string(),
            value: z.unknown().optional(),
            detail: z.string().optional(),
          })
          .parse(value),
      ),
    ]);
    expect(code).toBe(0);
    expect(output.status).toBe(status);
    expect(await Bun.file(`${root}/call.json`).json()).toEqual({
      args: ["api", "--include", "repos/test/repo", "--input", "-"],
      input: "exact",
    });
    if (detail !== undefined) expect(output.detail).toBe(detail);
    if (status === "failed") expect(output).toMatchObject({ httpStatus: 404, code: "http_404" });
    if (status === "succeeded")
      expect(output.value).toEqual({ httpStatus: 200, body: { value: 1 } });
  },
);
