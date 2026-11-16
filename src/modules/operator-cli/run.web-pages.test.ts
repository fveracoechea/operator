import { expect, test } from "bun:test";
// Bun has no temporary-directory, permission, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";

test("the public CLI opens only an explicitly requested safe page through a controlled opener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "operator-web-cli-"));
  try {
    const paths = OperatorHome.resolve(
      Environment.parse({ HOME: root, XDG_STATE_HOME: `${root}/state` }),
    );
    expect(
      DeviceState.registerProject(paths, {
        repository: "example/one",
        checkout: root,
        registeredAt: "now",
      }).tag,
    ).toBe("Ok");
    const log = `${root}/opener.json`;
    const fake = `#!${process.execPath}\nawait Bun.write(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`;
    for (const name of ["xdg-open", "open"]) {
      await Bun.write(`${root}/tools/${name}`, fake, { createPath: true });
      await chmod(`${root}/tools/${name}`, 0o755);
    }
    const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
    async function run(args: string[], remote = false) {
      const child = Bun.spawn([process.execPath, cli, "web", "open", ...args, "--json"], {
        env: Environment.child({
          HOME: root,
          XDG_CONFIG_HOME: `${root}/config`,
          XDG_STATE_HOME: `${root}/state`,
          PATH: `${root}/tools`,
          DISPLAY: ":0",
          WAYLAND_DISPLAY: undefined,
          SSH_CONNECTION: remote ? "fixture-remote" : undefined,
          SSH_CLIENT: undefined,
          SSH_TTY: undefined,
          BROWSER: undefined,
          CI: undefined,
          TERM_PROGRAM: "Apple_Terminal",
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return { code, output: JSON.parse(stdout) as unknown };
    }
    const url = "https://example.invalid/a?literal=$(not-a-command)&one=1";
    expect(await run(["--url", url])).toMatchObject({
      code: 4,
      output: { reason: "web_page_not_requested" },
    });
    expect(await Bun.file(log).exists()).toBe(false);
    expect(
      await run(["--url", "https://user:secret@example.invalid", "--person-requested"]),
    ).toMatchObject({ code: 2, output: { reason: "web_page_url_invalid" } });
    expect(await Bun.file(log).exists()).toBe(false);
    expect(await run(["--url", url, "--person-requested"], true)).toMatchObject({
      code: 3,
      output: { reason: "web_page_capability_limited" },
    });
    expect(await Bun.file(log).exists()).toBe(false);
    expect(await run(["--url", url, "--person-requested"])).toMatchObject({
      code: 0,
      output: { reason: "web_page_opener_accepted", data: { url } },
    });
    expect(await Bun.file(log).json()).toEqual([url]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
