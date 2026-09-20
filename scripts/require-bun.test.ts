import { expect, test } from "bun:test";

const scriptPath = new URL("./require-bun.ts", import.meta.url).pathname;

async function runPreinstall(userAgent: string) {
  const child = Bun.spawn(["bun", scriptPath], {
    env: { ...Bun.env, npm_config_user_agent: userAgent },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

test("allows Bun to install dependencies", async () => {
  expect(await runPreinstall(`bun/${Bun.version}`)).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "",
  });
});

test("refuses another package manager", async () => {
  expect(await runPreinstall("npm/11.0.0")).toEqual({
    exitCode: 1,
    stderr: "Operator dependencies must be installed with Bun.\n",
    stdout: "",
  });
});
