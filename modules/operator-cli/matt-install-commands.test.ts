import { afterEach, expect, test as bunTest } from "bun:test";
// Bun has no realpath, recursive directory removal, or symlink API.
import { realpath, rm, symlink } from "node:fs/promises";

// Installation tests spawn CLI processes and a local upstream server under the CI gate.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const cli = new URL("../../cli.ts", import.meta.url).pathname;
const roster = JSON.parse(
  await Bun.file(new URL("../../skills-lock.json", import.meta.url)).text(),
) as {
  skills: Record<string, { source: string; skillPath: string }>;
};
const commit = "a".repeat(40);
const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeUpstream() {
  let version = 1;
  let corrupt = false;
  const entries = Object.entries(roster.skills).filter(
    ([name, entry]) => entry.source === "mattpocock/skills" && !["unslop", "cursor"].includes(name),
  );
  entries.push([
    "new-upstream-skill",
    { source: "mattpocock/skills", skillPath: "skills/misc/new-upstream-skill/SKILL.md" },
  ]);
  entries.push([
    "unslop",
    { source: "mattpocock/skills", skillPath: "skills/misc/unslop/SKILL.md" },
  ]);
  entries.push([
    "operator",
    { source: "mattpocock/skills", skillPath: "skills/misc/operator/SKILL.md" },
  ]);
  const blobs = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/commits/main")) return Response.json({ sha: commit });
      if (path.endsWith(`/git/trees/${commit}`)) {
        blobs.clear();
        const tree = entries.map(([name, entry]) => {
          const content = `---\nname: ${name}\n---\nversion ${version}\n`;
          const hasher = new Bun.CryptoHasher("sha1");
          hasher.update(`blob ${Buffer.byteLength(content)}\0`);
          hasher.update(content);
          const sha = hasher.digest("hex");
          blobs.set(name, content);
          return { path: entry.skillPath, type: "blob", sha };
        });
        return Response.json({ truncated: false, tree });
      }
      const name = path.split("/").at(-2);
      const content = name === undefined ? undefined : blobs.get(name);
      return content === undefined
        ? new Response("missing", { status: 404 })
        : new Response(corrupt && name === "code-review" ? "changed after tree\n" : content);
    },
  });
  servers.push(server);
  return {
    url: server.url.origin,
    setVersion(next: number) {
      version = next;
    },
    corruptBlob() {
      corrupt = true;
    },
  };
}

async function project() {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-matt-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`.quiet();
  roots.push(root);
  return root;
}

async function runText(root: string, url: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "install", "matt", ...args], {
    cwd: root,
    env: { ...process.env, OPERATOR_MATT_SKILLS_API: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exit, stdout };
}

async function run(root: string, url: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "install", "matt", ...args, "--json"], {
    cwd: root,
    env: { ...process.env, OPERATOR_MATT_SKILLS_API: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exit,
    stdout,
    json: JSON.parse(stdout) as {
      outcome: string;
      reason: string;
      data: { commit: string; planId: string; changes: unknown[] };
      blockers: Array<{ paths: string[] }>;
    },
    stderr,
  };
}

test("plans pinned Matt skills, then installs only selected hosts after approval", async () => {
  const root = await project();
  const upstream = fakeUpstream();
  const plan = await run(root, upstream.url, ["plan", "--opencode"]);
  expect(plan.exit).toBe(0);
  expect(plan.json.data.commit).toBe(commit);
  expect(plan.stdout).toStartWith(
    `{"schemaVersion":1,"outcome":"completed","reason":"matt_plan_ready","operation":"install_matt_plan","blockers":[],"data":{"commit":"${commit}","planId":"${plan.json.data.planId}","targets":["opencode"],"changes":[`,
  );
  const planText = await runText(root, upstream.url, ["plan", "--opencode"]);
  expect(planText.stdout).toStartWith(`Matt skills at upstream commit ${commit}.\n  install `);
  expect(planText.stdout).toEndWith(
    `\nApprove with: operator install matt apply --opencode --commit ${commit} --approved-plan ${plan.json.data.planId}\n`,
  );
  expect(await Bun.file(`${root}/.agents/skills/code-review/SKILL.md`).exists()).toBe(false);
  const missing = await run(root, upstream.url, ["apply", "--opencode", "--commit", commit]);
  expect(missing.exit).toBe(3);
  expect(missing.stdout).toStartWith(
    `{"schemaVersion":1,"outcome":"missing-condition","reason":"approval_required","operation":"install_matt_apply","blockers":[{"reason":"approval_required","planId":"${plan.json.data.planId}"}],"data":{"commit":"${commit}","planId":"${plan.json.data.planId}","targets":["opencode"],"changes":[`,
  );
  const missingText = await runText(root, upstream.url, [
    "apply",
    "--opencode",
    "--commit",
    commit,
  ]);
  expect(missingText.stdout).toBe(planText.stdout);
  const applied = await run(root, upstream.url, [
    "apply",
    "--opencode",
    "--commit",
    commit,
    "--approved-plan",
    plan.json.data.planId,
  ]);
  expect(applied.exit).toBe(0);
  expect(applied.stdout).toStartWith(
    `{"schemaVersion":1,"outcome":"completed","reason":"matt_skills_installed","operation":"install_matt_apply","blockers":[],"data":{"commit":"${commit}","planId":"${plan.json.data.planId}","targets":["opencode"],"changes":[`,
  );
  expect(await Bun.file(`${root}/.agents/skills/code-review/SKILL.md`).text()).toContain(
    "version 1",
  );
  expect(await Bun.file(`${root}/.claude/skills/code-review/SKILL.md`).exists()).toBe(false);
  expect(await Bun.file(`${root}/.agents/skills/unslop/SKILL.md`).exists()).toBe(false);
  expect(await Bun.file(`${root}/.agents/skills/cursor/SKILL.md`).exists()).toBe(false);
  expect(await Bun.file(`${root}/.agents/skills/operator/SKILL.md`).exists()).toBe(false);
  expect(await Bun.file(`${root}/.agents/skills/new-upstream-skill/SKILL.md`).exists()).toBe(true);
  const repeat = await run(root, upstream.url, ["plan", "--opencode"]);
  expect(repeat.json.data.changes).toEqual([]);
});

test("updates managed copies, refuses local edits and stale approvals without writing", async () => {
  const root = await project();
  const upstream = fakeUpstream();
  const first = await run(root, upstream.url, ["plan", "--claude"]);
  await run(root, upstream.url, [
    "apply",
    "--claude",
    "--commit",
    commit,
    "--approved-plan",
    first.json.data.planId,
  ]);
  upstream.setVersion(2);
  const next = await run(root, upstream.url, ["plan", "--claude"]);
  expect(next.json.data.changes).toContainEqual(
    expect.objectContaining({
      skill: "code-review",
      target: "claude-code",
      path: ".claude/skills/code-review",
      kind: "update",
    }),
  );
  const file = `${root}/.claude/skills/code-review/SKILL.md`;
  await Bun.write(file, "my local edit\n");
  const conflict = await run(root, upstream.url, [
    "apply",
    "--claude",
    "--commit",
    commit,
    "--approved-plan",
    next.json.data.planId,
  ]);
  expect(conflict.exit).toBe(4);
  expect(conflict.stdout).toStartWith(
    `{"schemaVersion":1,"outcome":"conflict","reason":"skill_copy_conflict","operation":"install_matt_apply","blockers":[{"reason":"skill_copy_modified",`,
  );
  expect(conflict.json.blockers[0]?.paths).toContain(".claude/skills/code-review/SKILL.md");
  expect(await Bun.file(file).text()).toBe("my local edit\n");
  await Bun.write(file, "---\nname: code-review\n---\nversion 1\n");
  const stale = await run(root, upstream.url, [
    "apply",
    "--claude",
    "--commit",
    commit,
    "--approved-plan",
    first.json.data.planId,
  ]);
  expect(stale.exit).toBe(3);
  expect(stale.stdout).toStartWith(
    `{"schemaVersion":1,"outcome":"missing-condition","reason":"approval_stale","operation":"install_matt_apply","blockers":[{"reason":"approval_stale","planId":"${next.json.data.planId}"}],"data":{`,
  );
  const applied = await run(root, upstream.url, [
    "apply",
    "--claude",
    "--commit",
    commit,
    "--approved-plan",
    next.json.data.planId,
  ]);
  expect(applied.exit).toBe(0);
  expect(await Bun.file(file).text()).toContain("version 2");
});

test("an unrecorded edited skill blocks all targets and a changed upstream response invalidates approval", async () => {
  const root = await project();
  const upstream = fakeUpstream();
  const old = await run(root, upstream.url, ["plan", "--opencode", "--claude"]);
  upstream.setVersion(2);
  const stale = await run(root, upstream.url, [
    "apply",
    "--opencode",
    "--claude",
    "--commit",
    commit,
    "--approved-plan",
    old.json.data.planId,
  ]);
  expect(stale.exit).toBe(3);
  expect(await Bun.file(`${root}/.agents/skills/code-review/SKILL.md`).exists()).toBe(false);
  await Bun.write(`${root}/.claude/skills/code-review/SKILL.md`, "local text\n");
  const conflict = await run(root, upstream.url, ["plan", "--opencode", "--claude"]);
  expect(conflict.exit).toBe(4);
  expect(await Bun.file(`${root}/.agents/skills/code-review/SKILL.md`).exists()).toBe(false);
  expect(await Bun.file(`${root}/.claude/skills/code-review/SKILL.md`).text()).toBe("local text\n");
});

test("a deleted managed skill blocks an update without replacing its files", async () => {
  const root = await project();
  const upstream = fakeUpstream();
  const first = await run(root, upstream.url, ["plan", "--opencode"]);
  expect(
    (
      await run(root, upstream.url, [
        "apply",
        "--opencode",
        "--commit",
        commit,
        "--approved-plan",
        first.json.data.planId,
      ])
    ).exit,
  ).toBe(0);
  const file = `${root}/.agents/skills/code-review/SKILL.md`;
  await rm(file);
  upstream.setVersion(2);

  const conflict = await run(root, upstream.url, ["plan", "--opencode"]);

  expect(conflict.exit).toBe(4);
  expect(conflict.json.blockers[0]?.paths).toContain(".agents/skills/code-review/SKILL.md");
  expect(await Bun.file(file).exists()).toBe(false);
});

test("refuses a fetched file that does not match its Git blob", async () => {
  const root = await project();
  const upstream = fakeUpstream();
  const plan = await run(root, upstream.url, ["plan", "--opencode"]);
  upstream.corruptBlob();

  const result = await run(root, upstream.url, [
    "apply",
    "--opencode",
    "--commit",
    commit,
    "--approved-plan",
    plan.json.data.planId,
  ]);

  expect(result.exit).toBe(1);
  expect(result.json.reason).toBe("upstream_unavailable");
  expect(result.stdout).toStartWith(
    '{"schemaVersion":1,"outcome":"failed","reason":"upstream_unavailable","operation":"install_matt_apply","blockers":[{"reason":"upstream_unavailable","detail":"Error: ',
  );
  expect(await Bun.file(`${root}/.agents/skills/code-review/SKILL.md`).exists()).toBe(false);
});

test("refuses a symbolic link to a file inside a skill folder and writes nothing through it", async () => {
  const root = await project();
  const outside = await project();
  const upstream = fakeUpstream();
  const plan = await run(root, upstream.url, ["plan", "--opencode"]);
  const target = `${outside}/kept.md`;
  await Bun.write(target, "outside text\n");
  const link = `${root}/.agents/skills/code-review/SKILL.md`;
  await Bun.$`mkdir -p ${root}/.agents/skills/code-review`.quiet();
  await symlink(target, link);

  const result = await run(root, upstream.url, [
    "apply",
    "--opencode",
    "--commit",
    commit,
    "--approved-plan",
    plan.json.data.planId,
  ]);

  expect(result.exit).toBe(1);
  // The CLI resolves its working directory through links, such as the macOS temporary directory.
  const shown = `${await realpath(root)}/.agents/skills/code-review/SKILL.md`;
  expect(result.stdout).toBe(
    `{"schemaVersion":1,"outcome":"failed","reason":"upstream_unavailable","operation":"install_matt_apply","blockers":[{"reason":"upstream_unavailable","detail":"Error: Symbolic link in skill path: ${shown}"}]}\n`,
  );
  expect(await Bun.file(target).text()).toBe("outside text\n");
  expect(await Bun.file(`${root}/.agents/skills/.operator-matt-skills.json`).exists()).toBe(false);
});
