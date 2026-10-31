import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { registerTestDevice } from "../../scripts/device-fixture.ts";

let root = "";
let databaseBefore: ArrayBuffer;
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-upstream-"));
  databaseBefore = await registerTestDevice(root);
});
afterEach(async () => {
  try {
    expect(await Bun.file(`${root}/state/operator/operator.sqlite`).arrayBuffer()).toEqual(
      databaseBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function executable(name: string, source: string) {
  await Bun.write(`${root}/tools/${name}`, `#!${process.execPath}\n${source}`, {
    createPath: true,
  });
  await chmod(`${root}/tools/${name}`, 0o755);
}
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "install", ...args, "--json"], {
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

// A fake Git for one kind of failure. Only Matt's repository changes, and the pinned sources
// keep the folders that the release selects.
function git(matt: string, revision: string) {
  const pinned = {
    "https://github.com/cursor/plugins.git": "pstack/skills/unslop",
    "https://github.com/humanlayer/skills.git": "plugins/show-me/skills/show-me",
  };
  return `const a=process.argv.slice(2); const pinned=${JSON.stringify(pinned)}; if(a[0]==="clone") { const folder=pinned[a.at(-2)]; if(folder) await Bun.write(a.at(-1)+"/"+folder+"/SKILL.md","---\\nname: "+folder.split("/").at(-1)+"\\n---\\n",{createPath:true}); else { ${matt} } } else console.log(${JSON.stringify(revision)});`;
}

test.each(["main", "abcdef1", "", "a".repeat(39)])(
  "a non-full upstream revision %s refuses before installer effects",
  async (revision) => {
    await executable(
      "git",
      git(
        `await Bun.write(a.at(-1)+"/skills/engineering/code-review/SKILL.md", "---\\nname: code-review\\n---\\n",{createPath:true});`,
        revision,
      ),
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
      git(
        `if(${JSON.stringify(kind)}==="clone-failed") process.exit(1); await Bun.write(a.at(-1)+"/skills/engineering/test/SKILL.md",${JSON.stringify(kind === "bad-roster" ? "broken" : `---\nname: ${kind === "owned-only" ? "bun" : "code-review"}\n---\n`)},{createPath:true});`,
        "a".repeat(40),
      ),
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
