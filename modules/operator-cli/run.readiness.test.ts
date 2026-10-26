import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { chmod, cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

let root = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-readiness-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run() {
  const child = Bun.spawn([process.execPath, cli, "ready", "--json"], {
    cwd: root,
    env: Environment.child({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      PATH: `${root}/tools`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: JSON.parse(stdout) as unknown, stderr };
}

test("reports missing tools and configured host without creating state or launching a probe", async () => {
  expect(await run()).toMatchObject({
    code: 3,
    output: {
      operation: "ready",
      reason: "not_ready",
      blockers: [
        { reason: "executable_missing", tool: "gh" },
        { reason: "executable_missing", tool: "herdr" },
        { reason: "host_unconfigured" },
      ],
    },
  });
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([]);
});

async function configure(host: string) {
  await Bun.write(`${root}/config/operator/config.json`, JSON.stringify({ superAgent: { host } }), {
    createPath: true,
  });
  await cp(Bun.fileURLToPath(new URL("../../skills", import.meta.url)), `${root}/release`, {
    recursive: true,
  });
  const folder =
    host === "opencode" ? `${root}/config/opencode/skills` : `${root}/home/.claude/skills`;
  // A linked skill directory must pass without a managed ledger.
  await Bun.write(`${folder}/placeholder`, "", { createPath: true });
  await rm(folder, { recursive: true });
  await symlink(`${root}/release`, folder);
  const upstream = host === "opencode" ? `${root}/home/.agents/skills` : folder;
  await Bun.write(
    `${root}/independent-code-review/SKILL.md`,
    "an independently revised upstream skill\n",
    { createPath: true },
  );
  await Bun.write(`${upstream}/placeholder`, "", { createPath: true });
  await symlink(`${root}/independent-code-review`, `${upstream}/code-review`);
  for (const tool of ["gh", "herdr", host === "opencode" ? "opencode" : "claude"]) {
    await Bun.write(
      `${root}/tools/${tool}`,
      `#!${process.execPath}\nconst args=process.argv.slice(2); await Bun.write(${JSON.stringify(`${root}/calls`)},JSON.stringify(args)); if(${JSON.stringify(tool)}!=="gh" || JSON.stringify(args)!==JSON.stringify(["auth","status","--hostname","github.com"])) process.exit(99);`,
      { createPath: true },
    );
    await chmod(`${root}/tools/${tool}`, 0o755);
  }
  return { folder, upstream };
}

test.each(["opencode", "claude-code"])(
  "static readiness for %s follows links without host launches or Slack",
  async (host) => {
    await configure(host);
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(result.output).toMatchObject({
      reason: "ready",
      blockers: [],
      data: { staticOnly: true },
    });
    expect(await Bun.file(`${root}/calls`).json()).toEqual([
      "auth",
      "status",
      "--hostname",
      "github.com",
    ]);
    expect(await Bun.file(`${root}/state/operator/owned-skills.json`).exists()).toBe(false);
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
    expect(await Bun.file(`${root}/.operator/probe.json`).exists()).toBe(false);
  },
);

test("reports failed authentication, a missing host, changed owned assets, and a missing upstream skill together", async () => {
  const { folder, upstream } = await configure("opencode");
  await Bun.write(`${folder}/deep-modules/module-shape.md`, "personal edit\n");
  await rm(`${upstream}/code-review`);
  await rm(`${root}/tools/opencode`);
  await Bun.write(`${root}/tools/gh`, `#!${process.execPath}\nprocess.exit(1);`);
  const result = await run();
  expect(result.code).toBe(3);
  expect(result.output).toMatchObject({
    reason: "not_ready",
    blockers: [
      { reason: "github_auth_failed" },
      { reason: "executable_missing", tool: "opencode" },
      { reason: "skill_copy_conflict" },
      { reason: "upstream_skills_missing" },
    ],
  });
  expect(await Bun.file(`${folder}/deep-modules/module-shape.md`).text()).toBe("personal edit\n");
  expect(await Bun.file(`${root}/state/operator/operator.sqlite`).exists()).toBe(false);
});
