import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

let root = "";
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-upstream-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function executable(name: string, source: string) {
  await Bun.write(`${root}/tools/${name}`, `#!${process.execPath}\n${source}`, {
    createPath: true,
  });
  await chmod(`${root}/tools/${name}`, 0o755);
}
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "install", "matt", ...args, "--json"], {
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

test("delegates an exact installer and full commit with explicit global hosts and a positive non-owned roster", async () => {
  const sha = "a".repeat(40);
  await executable(
    "git",
    `const a=process.argv.slice(2); if(a[0]==="clone") { for(const name of ["code-review","unslop","cursor","bun","super-agent"]) await Bun.write(a.at(-1)+"/skills/"+name+"/SKILL.md", "---\\nname: "+name+"\\ndescription: A skill.\\n---\\n", {createPath:true}); } else console.log(${JSON.stringify(sha)});`,
  );
  await executable(
    "bun",
    `await Bun.write(${JSON.stringify(`${root}/invocation.json`)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})); console.log(JSON.stringify(["code-review","cursor","unslop"].map(name=>({name,status:"installed"}))));`,
  );
  const result = await run(["--opencode", "--claude"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.output).toMatchObject({
    reason: "upstream_installed",
    data: {
      commit: sha,
      installerVersion: "1.7.4",
      hosts: ["opencode", "claude-code"],
      skills: ["code-review", "cursor", "unslop"],
    },
  });
  expect(result.stderr).toContain("replacement");
  const invocation: unknown = await Bun.file(`${root}/invocation.json`).json();
  expect(invocation).toMatchObject({
    args: [
      "x",
      "--bun",
      "skills@1.7.4",
      "add",
      `mattpocock/skills#${sha}`,
      "--global",
      "--agent",
      "opencode",
      "claude-code",
      "--skill",
      "code-review",
      "cursor",
      "unslop",
      "--yes",
      "--json",
    ],
  });
  expect(await Bun.file(`${root}/state/operator/owned-skills.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/skills-lock.json`).exists()).toBe(false);
  expect(await Bun.file(`${root}/.agents/skills/code-review/SKILL.md`).exists()).toBe(false);
});

test.each(["main", "abcdef1", "", "a".repeat(39)])(
  "a non-full upstream revision %s refuses before installer effects",
  async (revision) => {
    await executable(
      "git",
      `const a=process.argv.slice(2); if(a[0]==="clone") await Bun.write(a.at(-1)+"/skills/code-review/SKILL.md", "---\\nname: code-review\\n---\\n",{createPath:true}); else console.log(${JSON.stringify(revision)});`,
    );
    await executable(
      "bun",
      `await Bun.write(${JSON.stringify(`${root}/forbidden`)},"installer ran");`,
    );
    expect(await run(["--claude"])).toMatchObject({
      code: 1,
      output: { reason: "upstream_catalog_invalid" },
    });
    expect(await Bun.file(`${root}/forbidden`).exists()).toBe(false);
  },
);

test.each([
  "clone-failed",
  "git-missing",
  "bad-roster",
  "owned-only",
  "bun-missing",
  "installer-failed",
  "partial-answer",
])("%s stays explicit without a second content ledger", async (kind) => {
  if (kind !== "git-missing")
    await executable(
      "git",
      `const a=process.argv.slice(2); if(a[0]==="clone") { if(${JSON.stringify(kind)}==="clone-failed") process.exit(1); await Bun.write(a.at(-1)+"/skills/test/SKILL.md",${JSON.stringify(kind === "bad-roster" ? "broken" : `---\nname: ${kind === "owned-only" ? "bun" : "code-review"}\n---\n`)},{createPath:true}); } else console.log("${"a".repeat(40)}");`,
    );
  if (kind !== "bun-missing")
    await executable(
      "bun",
      `await Bun.write(${JSON.stringify(`${root}/invoked`)},"yes"); ${kind === "installer-failed" ? "process.exit(1);" : "console.log('[]');"}`,
    );
  const reason =
    kind === "clone-failed" || kind === "git-missing"
      ? "upstream_resolution_failed"
      : kind === "bad-roster" || kind === "owned-only"
        ? "upstream_catalog_invalid"
        : kind === "bun-missing"
          ? "upstream_installer_unavailable"
          : kind === "installer-failed"
            ? "upstream_install_failed"
            : "upstream_install_unconfirmed";
  expect(await run(["--opencode"])).toMatchObject({
    code: kind === "partial-answer" ? 5 : 1,
    output: { reason },
  });
  expect(await Bun.file(`${root}/invoked`).exists()).toBe(
    ["installer-failed", "partial-answer"].includes(kind),
  );
  expect(await Bun.file(`${root}/state/operator/upstream-skills.json`).exists()).toBe(false);
});

test.each(
  [
    ["plan", "--claude"],
    ["apply", "--claude"],
    ["--claude", "--check"],
    ["--claude", "--claude"],
    [],
  ].map((args) => ({ args })),
)("invalid upstream flags $args invoke nothing", async ({ args }) => {
  expect((await run(args)).code).toBe(2);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([]);
});
