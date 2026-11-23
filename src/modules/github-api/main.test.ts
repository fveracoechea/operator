import { afterAll, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no temporary-directory, executable-permission or recursive-removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test.each([
  {
    response: 'HTTP/2.0 200 OK\n\n{"id":17}',
    expected: { status: "succeeded", value: { httpStatus: 200, body: { id: 17 } } },
  },
  {
    response: 'HTTP/2.0 403 Forbidden\n\n{"message":"denied"}',
    expected: { status: "failed", httpStatus: 403, code: "http_403", detail: "denied" },
  },
])(
  "the public GitHub interface returns $expected.status from the real executable boundary",
  async ({ response, expected }) => {
    const root = await mkdtemp(path.join(tmpdir(), "github-interface-"));
    roots.push(root);
    await Bun.write(
      path.join(root, "bin/gh"),
      `#!${process.execPath}
await Bun.write(${JSON.stringify(path.join(root, "request.json"))}, JSON.stringify({ args: Bun.argv.slice(2), input: await Bun.stdin.text() }));
process.stdout.write(${JSON.stringify(response)});
`,
    );
    await chmod(path.join(root, "bin/gh"), 0o755);
    const entry = new URL("./main.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
const { GithubApi } = await import(${JSON.stringify(entry)});
console.log(JSON.stringify(await GithubApi.call({ args: ["repos/example/project", "--input", "-"], input: '{"title":"contract"}', timeoutMs: 5000 })));
`,
      ],
      {
        env: Environment.child({
          PATH: path.join(root, "bin"),
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_STATE_HOME: path.join(root, "state"),
        }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject(expected);
    expect(await Bun.file(path.join(root, "request.json")).json()).toEqual({
      args: ["api", "--include", "repos/example/project", "--input", "-"],
      input: '{"title":"contract"}',
    });
  },
);
