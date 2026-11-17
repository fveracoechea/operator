import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary-directory, symlink, permission, or recursive removal API.
import {
  writeClaudeHookSettings,
  writeOpenCodePlugin,
  writeGuideSkills,
} from "./command-fixture.ts";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { workflowOutputSchema } from "../../lib/cli-result-fixture.ts";
import { expectWorkflowRefusal } from "./worker-fixture.ts";
import { fakeHerdrScript } from "./herdr-fixture.ts";
import { fakeGithubScript } from "./github-fixture.ts";

// Internal review is on by default, so these tests set no review setting. ADR-0020.

let root = "";
let checkout = "";
const workerPanes = new Map<string, string>();
const cli = Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url));
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function environment(caller: Record<string, string | undefined> = {}) {
  return Environment.child({
    ...gitEnv,
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HERDR_SOCKET_PATH: `${root}/herdr.sock`,
    PATH: `${root}/tools:${Environment.read().PATH}`,
    OPENCODE_SESSION_ID: "ses_supervisor",
    CLAUDE_CODE_SESSION_ID: undefined,
    HERDR_PANE_ID: "synthetic-supervisor-pane",
    ...caller,
  });
}

async function exec(
  args: string[],
  cwd = checkout,
  caller: Record<string, string | undefined> = {},
) {
  const child = Bun.spawn(args, {
    cwd,
    env: environment({
      HERDR_PANE_ID: workerPanes.get(cwd) ?? "synthetic-supervisor-pane",
      ...caller,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function run(
  args: string[],
  cwd = checkout,
  caller: Record<string, string | undefined> = {},
) {
  const result = await exec([process.execPath, cli, ...args, "--json"], cwd, caller);
  const output = workflowOutputSchema.parse(JSON.parse(result.stdout));
  expectWorkflowRefusal(args, output, result.stderr);
  return { code: result.code, output, stderr: result.stderr };
}

async function git(cwd: string, ...args: string[]) {
  const result = await exec(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function tool(name: string, script: string) {
  await Bun.write(`${root}/tools/${name}`, script, { createPath: true });
  await chmod(`${root}/tools/${name}`, 0o755);
}

const claude = `#!${process.execPath}
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
 for (const line of chunk.trim().split("\\n")) {
  const message=JSON.parse(line);
  if(message.type === "control_request") console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{models:[{value:"precise-model",supportsEffort:true,supportedEffortLevels:["medium","high"]}],commands:[],agents:[]}}}));
 }
}
`;
const opencode = `#!${process.execPath}
if(process.argv[3]==="post") console.log(JSON.stringify({data:{id:"ses_worker",...JSON.parse(process.argv[6])}}));
else {const dir=decodeURIComponent(process.argv[4].split("=")[1]);console.log(JSON.stringify({location:{directory:dir},data:[{providerID:"test",id:"reasoner",enabled:true,variants:[{id:"medium"},{id:"high"}]}]}));}
`;

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "implement",
      trackerKey: "github:example/one#12",
      instructions: "Implement the change.",
      kind: "implementation",
      resources: "worktree",
      branch: "task/12-implement",
      dependencies: [],
    },
    {
      key: "second",
      trackerKey: "github:example/one#13",
      instructions: "Implement the second change.",
      kind: "implementation",
      resources: "worktree",
      branch: "task/13-second",
      dependencies: [],
    },
  ],
};

async function setup(host: "opencode" | "claude-code") {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-pr-")));
  checkout = `${root}/checkout`;
  await mkdir(checkout);
  await git(checkout, "init", "-q", "-b", "main");
  await git(checkout, "remote", "add", "origin", "https://github.com/example/one.git");
  await Bun.write(`${checkout}/README.md`, "fixture\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "fixture");
  await tool("herdr", fakeHerdrScript(root));
  await tool("gh", fakeGithubScript(root));
  await symlink(cli, `${root}/tools/operator`);
  await tool("opencode", opencode);
  await tool("claude", claude);
  await Bun.write(
    `${root}/config/operator/config.json`,
    JSON.stringify({
      superAgent:
        host === "opencode" ? { host, model: "test/reasoner" } : { host, model: "precise-model" },
    }),
    { createPath: true },
  );
  await cp(Bun.fileURLToPath(new URL("../../../skills", import.meta.url)), `${root}/release`, {
    recursive: true,
  });
  const skills =
    host === "opencode" ? `${root}/config/opencode/skills` : `${root}/home/.claude/skills`;
  await mkdir(path.dirname(skills), { recursive: true });
  await symlink(`${root}/release`, skills);
  const upstream = host === "opencode" ? `${root}/home/.agents/skills` : skills;
  await Bun.write(`${root}/upstream/code-review/SKILL.md`, "upstream\n", { createPath: true });
  await mkdir(upstream, { recursive: true });
  await symlink(`${root}/upstream/code-review`, `${upstream}/code-review`);
  await writeGuideSkills(upstream);
  await writeClaudeHookSettings(`${root}/home`);
  await writeOpenCodePlugin(`${root}/config`);
  expect((await run(["project", "register"])).code).toBe(0);
  expect((await run(["herdr", "install"])).code).toBe(0);
  await Bun.write(`${root}/plan.json`, JSON.stringify(plan));
  const registered = await run(["source", "register", "--file", `${root}/plan.json`]);
  return z.object({ data: z.object({ id: z.string() }) }).parse(registered.output).data.id;
}

afterEach(async () => {
  workerPanes.clear();
  await rm(root, { recursive: true, force: true });
});

async function dispatch(source: string, assignment = "implement") {
  const launched = await run(["dispatch", "--source", source, "--assignment", assignment]);
  expect(launched.code, launched.stderr).toBe(0);
  const worker = z
    .object({ data: z.object({ worktreePath: z.string(), paneId: z.string(), brief: z.string() }) })
    .parse(launched.output).data;
  workerPanes.set(worker.worktreePath, worker.paneId);
  return worker;
}

type Pull = Record<string, unknown> & { number: number };
async function github(change: { pulls?: Pull[]; queue?: object[]; fail?: string | null }) {
  const file = Bun.file(`${root}/github.json`);
  const current: object = (await file.exists()) ? z.looseObject({}).parse(await file.json()) : {};
  await Bun.write(file, JSON.stringify({ ...current, ...change }));
}

function pull(change: Record<string, unknown> = {}): Pull {
  return {
    number: 7,
    url: "https://github.com/example/one/pull/7",
    headRefName: "task/12-implement",
    headRepository: "example/one",
    state: "OPEN",
    ...change,
  };
}

async function entry(source: string, assignment = "implement") {
  const next = await run(["next", "--source", source]);
  const rows = z
    .object({
      data: z.object({
        sources: z.array(
          z.object({
            actions: z.array(z.looseObject({ assignment: z.string().optional() })),
            waits: z.array(z.looseObject({ assignment: z.string().optional() })),
          }),
        ),
      }),
    })
    .parse(next.output)
    .data.sources.flatMap((row) => [...row.actions, ...row.waits]);
  return rows.find((row) => row.assignment === assignment);
}

const statusSchema = z.object({
  data: z.object({
    launches: z.array(
      z.looseObject({
        id: z.string(),
        attempt: z.number(),
        state: z.string(),
        paneId: z.string().nullable(),
        worktreePath: z.string().nullable(),
        internalReview: z.boolean().nullable(),
      }),
    ),
    internalReviews: z.array(
      z.looseObject({ handoffState: z.string(), handoffRunning: z.boolean() }),
    ),
  }),
});

async function shown(source: string) {
  return statusSchema.parse((await run(["source", "show", "--source", source])).output).data;
}

/**
 * The association starts the handoff in its own process. The reviewer's reservation ends the
 * handoff before the reviewer runs, so each test waits until no launch is starting either.
 */
async function handedOff(source: string) {
  function settled(state: Awaited<ReturnType<typeof shown>>) {
    const review = state.internalReviews[0];
    return (
      review !== undefined &&
      !review.handoffRunning &&
      state.launches.every((launch) => launch.state !== "starting")
    );
  }
  let state = await shown(source);
  for (let attempt = 0; attempt < 300 && !settled(state); attempt++) {
    await Bun.sleep(100);
    state = await shown(source);
  }
  return state.internalReviews[0];
}

async function calls(file: string, text: string) {
  const handle = Bun.file(`${root}/${file}`);
  if (!(await handle.exists())) return 0;
  return (await handle.text())
    .trim()
    .split("\n")
    .filter((line) => line.includes(text)).length;
}

async function commit(worktree: string, file: string) {
  await Bun.write(`${worktree}/${file}`, `${file}\n`);
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", file);
  return git(worktree, "rev-parse", "HEAD");
}

async function findings(
  items: { severity: string; axis: string; location: string; claim: string }[],
) {
  const file = `${root}/findings.md`;
  await Bun.write(
    file,
    `## Findings\n${items.map((item) => `- ${item.severity}, ${item.axis}, ${item.location}: ${item.claim}`).join("\n")}\n`,
  );
  return file;
}

const blocker = {
  axis: "Spec",
  severity: "blocker",
  location: "a.ts:1",
  claim: "The guard is missing.",
};

function workerCaller(paneId: string, host: "opencode" | "claude-code" = "opencode") {
  return {
    OPENCODE_SESSION_ID: host === "opencode" ? "ses_worker" : undefined,
    CLAUDE_CODE_SESSION_ID: host === "claude-code" ? "claude-worker" : undefined,
    HERDR_PANE_ID: paneId,
  };
}

async function pendingContinuation() {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  await herdrFail({ "pane close": "fixture holds the outgoing pane" });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  expect(await handedOff(source)).toMatchObject({ handoffState: "failed" });
  await herdrFail({});
  return { source, worker };
}

function fixtureDatabase() {
  const db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

async function processResult(child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function publisher() {
  return Bun.spawn(
    [
      process.execPath,
      "-e",
      `const until=Date.now()+5000; while(!(await Bun.file(${JSON.stringify(`${root}/publish-release`)}).exists()) && Date.now()<until) await Bun.sleep(10);`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
}

function continuationChild(
  source: string,
  pane: string,
  publishingPid: number,
  options: { flags?: string[]; caller?: Record<string, string | undefined>; preload?: string } = {},
) {
  return Bun.spawn(
    [
      process.execPath,
      ...(options.preload ? ["--preload", options.preload] : []),
      cli,
      "dispatch",
      "--source",
      source,
      "--assignment",
      "implement",
      "--after-pid",
      String(publishingPid),
      ...(options.flags ?? []),
      "--json",
    ],
    {
      cwd: checkout,
      env: environment({ ...workerCaller(pane), ...options.caller }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function continuationOptions(mode: string, source: string, publishingPid: number) {
  const callers: Record<string, Record<string, string>> = {
    "wrong-pane": { HERDR_PANE_ID: "unrelated-pane" },
    "wrong-socket": { HERDR_SOCKET_PATH: `${root}/other.sock` },
  };
  const flags: Record<string, string[]> = {
    "duplicate-source": ["--source", source],
    "duplicate-after-pid": ["--after-pid", String(publishingPid)],
    "duplicate-assignment": ["--assignment", "second"],
  };
  return { flags: flags[mode] ?? [], caller: callers[mode] ?? {} };
}

function continuationFault(db: Database, mode: string, source: string, publishingPid: number) {
  db.query("UPDATE kind_handoffs SET handoff_state = 'pending', owner_pid = ?, lease_at = ?").run(
    publishingPid,
    new Date().toISOString(),
  );
  if (mode === "absent") db.exec("DELETE FROM kind_handoffs");
  if (mode === "failed" || mode === "done")
    db.query("UPDATE kind_handoffs SET handoff_state = ?").run(mode);
  if (mode === "stale") db.exec("UPDATE kind_handoffs SET lease_at = '2000-01-01'");
  if (mode === "malformed-lease") db.exec("UPDATE kind_handoffs SET lease_at = 'not-a-date'");
  if (mode === "absent-lease") db.exec("UPDATE kind_handoffs SET lease_at = NULL");
  if (mode === "future-lease") db.exec("UPDATE kind_handoffs SET lease_at = '2999-01-01'");
  if (mode === "wrong-assignment") db.exec("UPDATE kind_handoffs SET assignment = 'second'");
  continuationTargetFault(db, mode);
  if (mode === "wrong-repository")
    db.exec(
      "INSERT INTO projects VALUES ('example/two', '/synthetic-other-checkout', 'now'); UPDATE sources SET repository = 'example/two'",
    );
  if (mode === "later-launch")
    db.query(
      "INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, host, model, requested_model, reasoning_effort, release, skills, started_at) VALUES ('later', ?, 'implement', 2, 'failed', 'later', 'worktree', 'opencode', 'fixture', 'fixture', 'high', '{}', '[]', 'now')",
    ).run(source);
}

function continuationTargetFault(db: Database, mode: string) {
  const changes: Record<string, string> = {
    "wrong-outgoing": "UPDATE kind_handoffs SET outgoing_launch_id = 'unrelated'",
    "ended-source": "UPDATE sources SET state = 'reset'",
    "inactive-assignment": "UPDATE assignments SET state = 'abandoned'",
    "wrong-completion": "UPDATE kind_handoffs SET next_kind = 'research'",
    "unknown-kind": "UPDATE kind_handoffs SET next_kind = 'unknown'",
  };
  const change = changes[mode];
  if (change !== undefined) db.exec(change);
}

/** Faults at public SQLite calls in the real CLI, never at a private workflow helper. */
async function continuationBoundary(
  mode:
    | "observe"
    | "claim-loss"
    | "preclose-loss"
    | "reservation-loss"
    | "claim-target"
    | "reservation-target"
    | "takeover"
    | "later-launch",
  source: string,
) {
  const file = `${root}/continuation-boundary.ts`;
  const changed =
    mode === "takeover"
      ? "UPDATE sources SET supervising_session = 'ses_new_supervisor', supervising_pane = 'new-supervisor-pane'"
      : mode === "later-launch"
        ? `INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, host, model, requested_model, reasoning_effort, release, skills, started_at) VALUES ('concurrent', '${source}', 'implement', 2, 'failed', 'concurrent', 'worktree', 'opencode', 'fixture', 'fixture', 'high', '{}', '[]', 'now')`
        : mode.endsWith("target")
          ? "UPDATE kind_handoffs SET next_kind = 'pr-feedback'"
          : "UPDATE kind_handoffs SET lease_at = '2000-01-01'";
  await Bun.write(
    file,
    `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const prepare=Database.prototype.prepare, exec=Database.prototype.exec;
let reads=0, injected=false, claimWritten=false, claimCommitted=false;
Database.prototype.prepare=function(sql,...args) {
  if(sql.includes('from "kind_handoffs" inner join "sources"')) { reads++; writeFileSync(${JSON.stringify(`${root}/continuation-reads`)},String(reads)); }
  const statement=prepare.call(this,sql,...args);
  if(sql.startsWith('update "kind_handoffs" set ') && sql.includes('"outgoing_launch_id" =')) {
    const run=statement.run;
    statement.run=function(...bindings) { const result=run.apply(this,bindings); claimWritten=true; return result; };
  }
  return statement;
};
Database.prototype.exec=function(sql,...args) {
  if(sql==="BEGIN IMMEDIATE" && !injected && ${JSON.stringify(mode)}!=="observe") {
    using competing=new Database(${JSON.stringify(`${root}/state/operator/operator.sqlite`)});
    const outgoing=competing.query("SELECT launches.state FROM launches JOIN kind_handoffs ON kind_handoffs.outgoing_launch_id = launches.id").get();
    const boundary=${JSON.stringify(mode)}.startsWith("claim") ? reads>=2 && outgoing?.state==="running" : ${JSON.stringify(mode)}==="preclose-loss" ? claimCommitted && outgoing?.state==="running" : outgoing?.state==="finished";
    if(boundary) {
      injected=true;
      competing.exec(${JSON.stringify(changed)});
      writeFileSync(${JSON.stringify(`${root}/continuation-injected`)},JSON.stringify({claimCommitted,outgoingState:outgoing?.state}));
    }
  }
  const result=exec.call(this,sql,...args);
  if(sql==="COMMIT" && claimWritten && !claimCommitted) {
    claimCommitted=true;
    writeFileSync(${JSON.stringify(`${root}/continuation-claim-committed`)},JSON.stringify({claimCommitted}));
  }
  return result;
};`,
  );
  return file;
}

async function waitForFixture(file: string) {
  for (let attempt = 0; attempt < 200 && !(await Bun.file(file).exists()); attempt++)
    await Bun.sleep(10);
  expect(await Bun.file(file).exists()).toBe(true);
}

async function publicationRetriesBeforeClaim() {
  const reads = Bun.file(`${root}/continuation-reads`);
  await waitForFixture(`${root}/continuation-reads`);
  for (let attempt = 0; attempt < 100 && Number(await reads.text()) < 3; attempt++)
    await Bun.sleep(10);
  expect(Number(await reads.text())).toBeGreaterThanOrEqual(3);
  expect(await Bun.file(`${root}/continuation-claim-committed`).exists()).toBe(false);
}

test.each(["publish", "expire"] as const)(
  "a continuation waits read-only for exact PID publication and can %s safely",
  async (mode) => {
    const { source, worker } = await pendingContinuation();
    using db = fixtureDatabase();
    const parent = publisher();
    try {
      continuationFault(db, "pending", source, parent.pid);
      const before = db.serialize();
      const closes = await calls("herdr-calls.jsonl", '"pane","close"');
      const child = continuationChild(source, worker.paneId, parent.pid, {
        preload: await continuationBoundary("observe", source),
      });
      await waitForFixture(`${root}/continuation-reads`);
      expect(db.serialize()).toEqual(before);
      expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(closes);
      if (mode === "publish") {
        db.query("UPDATE kind_handoffs SET owner_pid = ? WHERE owner_pid = ?").run(
          child.pid,
          parent.pid,
        );
        await Bun.write(`${root}/publish-release`, "exit");
      }
      const result = await processResult(child);
      if (mode === "publish") {
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          reason: "worker_launched",
          data: {
            kind: { name: "review" },
            worktreePath: worker.worktreePath,
            branch: "task/12-implement",
          },
        });
      } else {
        expect(result.code, result.stderr).toBe(4);
        expect(JSON.parse(result.stdout)).toMatchObject({
          reason: "handoff_publication_timed_out",
        });
        expect(db.serialize()).toEqual(before);
        expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(closes);
      }
    } finally {
      await Bun.write(`${root}/publish-release`, "exit");
      await processResult(parent);
    }
    if (mode === "expire")
      expect(
        await run(["dispatch", "--source", source, "--assignment", "implement"]),
      ).toMatchObject({ code: 0, output: { data: { kind: { name: "review" } } } });
    expect(db.query("SELECT supervising_session, supervising_pane FROM sources").all()).toEqual([
      { supervising_session: "ses_supervisor", supervising_pane: "synthetic-supervisor-pane" },
    ]);
    expect((await shown(source)).launches).toHaveLength(2);
  },
  180000,
);

test.each([
  "claim-loss",
  "preclose-loss",
  "reservation-loss",
  "claim-target",
  "reservation-target",
  "takeover",
  "later-launch",
] as const)(
  "a continuation rechecks %s transactionally without fallback or supervisor overwrite",
  async (mode) => {
    const { source, worker } = await pendingContinuation();
    using db = fixtureDatabase();
    const parent = publisher();
    try {
      continuationFault(db, "pending", source, parent.pid);
      const closes = await calls("herdr-calls.jsonl", '"pane","close"');
      const starts = await calls("herdr-calls.jsonl", '"agent","start"');
      const child = continuationChild(source, worker.paneId, parent.pid, {
        preload: await continuationBoundary(mode, source),
      });
      if (mode === "preclose-loss") await publicationRetriesBeforeClaim();
      db.query("UPDATE kind_handoffs SET owner_pid = ? WHERE owner_pid = ?").run(
        child.pid,
        parent.pid,
      );
      await Bun.write(`${root}/publish-release`, "exit");
      const result = await processResult(child);
      expect(await Bun.file(`${root}/continuation-injected`).exists()).toBe(true);
      if (mode === "preclose-loss") {
        expect(await Bun.file(`${root}/continuation-claim-committed`).exists()).toBe(true);
        expect(await Bun.file(`${root}/continuation-injected`).json()).toEqual({
          claimCommitted: true,
          outgoingState: "running",
        });
      }
      if (mode === "takeover") {
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          reason: "worker_launched",
          data: { kind: { name: "review" } },
        });
        expect(db.query("SELECT supervising_session, supervising_pane FROM sources").all()).toEqual(
          [{ supervising_session: "ses_new_supervisor", supervising_pane: "new-supervisor-pane" }],
        );
      } else {
        expect(result.code, result.stderr).toBe(4);
        expect(JSON.parse(result.stdout)).toMatchObject({ reason: "handoff_continuation_refused" });
        expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(starts);
        expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(
          closes + (mode.startsWith("claim") || mode === "preclose-loss" ? 0 : 1),
        );
        expect(db.query("SELECT supervising_session, supervising_pane FROM sources").all()).toEqual(
          [
            {
              supervising_session: "ses_supervisor",
              supervising_pane: "synthetic-supervisor-pane",
            },
          ],
        );
        expect(db.query("SELECT handoff_state, owner_pid FROM kind_handoffs").all()).toEqual([
          { handoff_state: "pending", owner_pid: child.pid },
        ]);
        expect(await git(worker.worktreePath, "status", "--porcelain")).toBe("");
      }
    } finally {
      await Bun.write(`${root}/publish-release`, "exit");
      await processResult(parent);
    }
  },
  180000,
);

test.each([
  "zero",
  "unrelated-parent",
  "wrong-owner",
  "wrong-pane",
  "wrong-socket",
  "absent",
  "failed",
  "done",
  "stale",
  "malformed-lease",
  "absent-lease",
  "future-lease",
  "later-launch",
  "wrong-source",
  "wrong-assignment",
  "wrong-repository",
  "wrong-outgoing",
  "ended-source",
  "inactive-assignment",
  "wrong-completion",
  "unknown-kind",
  "duplicate-source",
  "duplicate-assignment",
  "duplicate-after-pid",
  "malformed-after-pid",
] as const)(
  "foreign continuation refuses %s without effects or supervisor changes",
  async (mode) => {
    const { source, worker } = await pendingContinuation();
    using db = fixtureDatabase();
    const parent = publisher();
    try {
      continuationFault(db, mode, source, parent.pid);
      const afterPid =
        mode === "zero"
          ? 0
          : mode === "malformed-after-pid"
            ? Number.NaN
            : mode === "unrelated-parent"
              ? process.pid
              : parent.pid;
      const child = continuationChild(
        mode === "wrong-source" ? "absent-source" : source,
        worker.paneId,
        afterPid,
        continuationOptions(mode, source, parent.pid),
      );
      if (!["wrong-owner", "zero", "unrelated-parent"].includes(mode))
        db.query("UPDATE kind_handoffs SET owner_pid = ?").run(child.pid);
      const before = db.serialize();
      const closes = await calls("herdr-calls.jsonl", '"pane","close"');
      const starts = await calls("herdr-calls.jsonl", '"agent","start"');
      const result = await processResult(child);
      expect(result.code).toBe(mode === "wrong-source" || mode === "wrong-repository" ? 3 : 4);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "refused" });
      expect(db.serialize()).toEqual(before);
      expect(await calls("herdr-calls.jsonl", '"pane","close"')).toBe(closes);
      expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(starts);
    } finally {
      await Bun.write(`${root}/publish-release`, "exit");
      await processResult(parent);
    }
  },
  180000,
);

test("timer renewal leaves a lost continuation lease unchanged and refuses the next launch", async () => {
  const { source, worker } = await pendingContinuation();
  using db = fixtureDatabase();
  continuationFault(db, "pending", source, process.pid);
  const stateFile = Bun.file(`${root}/herdr-state.json`);
  await Bun.write(
    stateFile,
    JSON.stringify({ ...z.looseObject({}).parse(await stateFile.json()), pausePaneClose: true }),
  );
  const starts = await calls("herdr-calls.jsonl", '"agent","start"');
  const child = continuationChild(source, worker.paneId, process.pid, {
    preload: await continuationBoundary("observe", source),
  });
  db.query("UPDATE kind_handoffs SET owner_pid = ?").run(child.pid);
  try {
    // The existing ten-second parent wait leaves the first fifteen-second renewal inside the paused external close.
    for (
      let attempt = 0;
      attempt < 1200 && !(await Bun.file(`${root}/pane-close-entered`).exists());
      attempt++
    )
      await Bun.sleep(10);
    expect(await Bun.file(`${root}/pane-close-entered`).exists()).toBe(true);
    db.exec("UPDATE kind_handoffs SET lease_at = '2000-01-01'");
    const before = db.serialize();
    const readsAtLoss = Number(await Bun.file(`${root}/continuation-reads`).text());
    for (
      let attempt = 0;
      attempt < 700 && Number(await Bun.file(`${root}/continuation-reads`).text()) === readsAtLoss;
      attempt++
    )
      await Bun.sleep(10);
    expect(Number(await Bun.file(`${root}/continuation-reads`).text())).toBeGreaterThan(
      readsAtLoss,
    );
    expect(db.serialize()).toEqual(before);
    expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(starts);
  } finally {
    await Bun.write(`${root}/pane-close-allowed`, "continue");
    await child.exited;
  }
  const result = await processResult(child);
  expect(result.code, result.stderr).toBe(4);
  expect(JSON.parse(result.stdout)).toMatchObject({ reason: "handoff_continuation_refused" });
  expect(db.query("SELECT handoff_state, owner_pid, lease_at FROM kind_handoffs").all()).toEqual([
    { handoff_state: "pending", owner_pid: child.pid, lease_at: "2000-01-01" },
  ]);
  expect((await shown(source)).launches).toHaveLength(1);
  expect(await calls("herdr-calls.jsonl", '"agent","start"')).toBe(starts);
  expect(await git(worker.worktreePath, "status", "--porcelain")).toBe("");
}, 180000);

test("pruning an ended assignment removes its generic handoff without deleting retained work", async () => {
  const { source, worker } = await pendingContinuation();
  using db = fixtureDatabase();
  db.exec(
    "UPDATE sources SET state = 'reset', ended_at = '2000-01-01'; UPDATE assignments SET state = 'abandoned'; UPDATE launches SET state = 'finished', ended_at = '2000-01-01'",
  );
  const head = await git(worker.worktreePath, "rev-parse", "HEAD");
  expect(await run(["source", "prune"])).toMatchObject({
    code: 0,
    output: { data: { pruned: [{ id: source }] } },
  });
  expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual([]);
  expect(db.query("SELECT * FROM internal_reviews").all()).toEqual([]);
  expect(db.query("SELECT * FROM launches").all()).toEqual([]);
  expect(await git(worker.worktreePath, "rev-parse", "HEAD")).toBe(head);
  expect(await git(worker.worktreePath, "symbolic-ref", "--short", "HEAD")).toBe(
    "task/12-implement",
  );
}, 180000);

test("an internal flag grants no supervisor dispatch fallback, while ordinary recovery remains authorized", async () => {
  const { source, worker } = await pendingContinuation();
  using db = fixtureDatabase();
  const before = db.serialize();
  const command = ["dispatch", "--source", source, "--assignment", "implement"];
  expect(await run([...command, "--after-pid", String(process.pid)])).toMatchObject({
    code: 4,
    output: { reason: "handoff_continuation_refused" },
  });
  expect(db.serialize()).toEqual(before);
  expect(await run(command)).toMatchObject({
    code: 0,
    output: {
      reason: "worker_launched",
      data: { kind: { name: "review" }, worktreePath: worker.worktreePath },
    },
  });
}, 180000);

test.each(["opencode", "claude-code"] as const)(
  "automatic kind handoff preserves distinct supervisor and %s worker identities",
  async (host) => {
    const source = await setup(host);
    const worker = await dispatch(source);
    const caller = {
      OPENCODE_SESSION_ID: host === "opencode" ? "ses_worker" : undefined,
      CLAUDE_CODE_SESSION_ID: host === "claude-code" ? "claude-worker" : undefined,
      HERDR_PANE_ID: worker.paneId,
    };
    const forbidden = ["dispatch", "--source", source, "--assignment", "implement"];
    expect(await run(forbidden, checkout, caller)).toMatchObject({
      code: 4,
      output: { reason: "source_supervised_elsewhere" },
    });
    const head = await commit(worker.worktreePath, "work.txt");
    await github({ pulls: [pull({ head, isDraft: true })] });
    expect(await run(["pr", "associate"], worker.worktreePath, caller)).toMatchObject({ code: 0 });
    expect(await handedOff(source)).toMatchObject({ handoffState: "done" });
    using db = fixtureDatabase();
    expect(db.query("SELECT supervising_session, supervising_pane FROM sources").all()).toEqual([
      { supervising_session: "ses_supervisor", supervising_pane: "synthetic-supervisor-pane" },
    ]);
    const topology = z
      .object({
        agents: z.array(
          z.looseObject({
            caller: z.object({
              pane: z.string().nullable(),
              opencode: z.string().nullable(),
              claude: z.string().nullable(),
            }),
          }),
        ),
      })
      .parse(await Bun.file(`${root}/herdr-state.json`).json());
    expect(topology.agents).toHaveLength(1);
    expect(topology.agents[0]?.caller).toEqual({
      pane: worker.paneId,
      opencode: host === "opencode" ? "ses_worker" : null,
      claude: host === "claude-code" ? "claude-worker" : null,
    });
    expect((await shown(source)).launches).toMatchObject([
      { state: "finished", worktreePath: worker.worktreePath },
      { state: "running", worktreePath: worker.worktreePath, kind: { name: "review" } },
    ]);
    expect(await run(forbidden, checkout, caller)).toMatchObject({
      code: 4,
      output: {
        reason: "source_supervised_elsewhere",
        state: { supervisorSession: "ses_supervisor" },
      },
    });
    expect(await run(forbidden)).toMatchObject({
      code: 4,
      output: { reason: "assignment_not_dispatchable" },
    });
    const beforeReplay = db.serialize();
    expect(
      await run([...forbidden, "--after-pid", String(process.pid)], checkout, caller),
    ).toMatchObject({ code: 4, output: { reason: "handoff_continuation_refused" } });
    expect(db.serialize()).toEqual(beforeReplay);
    expect((await shown(source)).launches).toHaveLength(2);
  },
  180000,
);

test("pr associate of a draft hands implementation to review and writes no note", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  expect(await Bun.file(worker.brief).text()).toContain("Phase: `build`");
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });

  const assignmentDirectory = path.dirname(worker.brief);
  const filesBefore = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: assignmentDirectory, dot: true, onlyFiles: true }),
  );
  expect(filesBefore).toEqual(["brief.md"]);

  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    code: 0,
    output: {
      reason: "pr_associated",
      data: {
        number: 7,
        state: "pr-open",
        internalReview: { state: "reviewing", handoff: "started" },
      },
    },
  });
  expect(await handedOff(source)).toMatchObject({ handoffState: "done" });

  const { launches } = await shown(source);
  expect(launches).toMatchObject([
    { attempt: 1, state: "finished", paneId: worker.paneId, kind: { name: "implementation" } },
    {
      attempt: 2,
      state: "running",
      worktreePath: worker.worktreePath,
      internalReview: true,
      kind: { name: "review", readsNote: false },
    },
  ]);
  expect(await calls("herdr-calls.jsonl", `"pane","close","${worker.paneId}"`)).toBe(1);
  expect(await calls("herdr-calls.jsonl", '"worktree","open"')).toBe(1);
  // The reviewer brief comes from the recorded review, with no draft-state wording.
  const brief = await Bun.file(worker.brief).text();
  expect(brief).toContain("## Handoff\n\nPR #7:");
  expect(brief).toContain("Worker kind: `review`");
  expect(brief).toContain("Phase: `review`");
  expect(brief).toContain(`Head: \`${await git(worker.worktreePath, "rev-parse", "HEAD")}\``);
  expect(brief).toContain("/worker-agent/kinds/review.md`");
  expect(brief).not.toContain("### Round");
  expect(brief).not.toContain("If the PR is a draft");
  expect(brief).not.toContain("## Note");
  // The only durable assignment file remains its rewritten brief, regardless of a possible note's name.
  expect(
    await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: assignmentDirectory, dot: true, onlyFiles: true }),
    ),
  ).toEqual(filesBefore);
  // The review runs as a wait, and the handoff left no failure in next.
  expect(await entry(source)).toMatchObject({
    action: "wait",
    reason: "internal_review_running",
    internalReview: { state: "reviewing", rounds: [], handoff: { state: "done" } },
  });
  // A repeated association or dispatch starts nothing.
  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({
    output: { reason: "pr_unchanged" },
  });
  expect(await run(["dispatch", "--source", source, "--assignment", "implement"])).toMatchObject({
    code: 4,
    output: { reason: "assignment_not_dispatchable" },
  });
  expect((await shown(source)).launches).toHaveLength(2);
}, 180000);

test("a failed reviewer start shows as replace_worker, and a dispatch starts the reviewer", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const head = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head, isDraft: true })] });
  await herdrFail({ "agent start": "the host did not start" });

  expect(await run(["pr", "associate"], worker.worktreePath)).toMatchObject({ code: 0 });
  expect(await handedOff(source)).toMatchObject({ handoffState: "done" });
  expect(await entry(source)).toMatchObject({ action: "replace_worker", reason: "launch_failed" });

  await herdrFail({});
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  expect((await shown(source)).launches.map((row) => row.state)).toEqual([
    "finished",
    "failed",
    "running",
  ]);
  expect(await Bun.file(worker.brief).text()).toContain("Worker kind: `review`");
}, 180000);

test("the reviewer records at most two rounds, the second at a newer head", async () => {
  const source = await setup("opencode");
  const worker = await dispatch(source);
  const first = await commit(worker.worktreePath, "work.txt");
  await github({ pulls: [pull({ head: first, isDraft: true })] });
  expect((await run(["pr", "associate"], worker.worktreePath)).code).toBe(0);
  await handedOff(source);
  const reviewer = worker.worktreePath;

  await Bun.write(`${root}/broken.json`, "{");
  expect(await run(["pr", "round", "--file", `${root}/broken.json`], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_findings_invalid" },
  });
  expect(
    await run(
      ["pr", "round", "--file", await findings([{ ...blocker, axis: "Security" }])],
      reviewer,
    ),
  ).toMatchObject({ code: 3, output: { reason: "internal_review_findings_invalid" } });
  await Bun.write(`${root}/malformed.md`, "## Findings\n\n- blocker, Spec, a.ts:1\n");
  const malformed = await run(["pr", "round", "--file", `${root}/malformed.md`], reviewer);
  expect(malformed).toMatchObject({
    code: 3,
    output: {
      reason: "internal_review_findings_invalid",
      next: { command: "operator pr round --file <path|->" },
    },
  });
  expect(malformed.stderr).toContain("Line 3");
  expect(await entry(source)).toMatchObject({ internalReview: { rounds: [] } });

  const nit = { axis: "Skills", severity: "nice-to-have", location: "b.ts", claim: "Name it." };
  expect(
    await run(["pr", "round", "--file", await findings([blocker, nit])], reviewer),
  ).toMatchObject({
    code: 0,
    output: {
      reason: "pr_round_recorded",
      data: { round: 1, head: first, findings: 2, blockers: 1 },
    },
  });
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 3,
    output: { reason: "internal_review_round_head" },
  });

  const second = await commit(reviewer, "fix.txt");
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 0,
    output: { data: { round: 2, head: second, findings: 0, blockers: 0 } },
  });
  await commit(reviewer, "more.txt");
  expect(await run(["pr", "round", "--file", await findings([])], reviewer)).toMatchObject({
    code: 3,
    output: {
      reason: "internal_review_round_limit",
      kind: "review",
      phase: "ready",
      next: { command: "operator pr ready --file <file>" },
      state: { rounds: 2 },
    },
  });
  expect(await entry(source)).toMatchObject({
    internalReview: {
      rounds: [
        { number: 1, head: first, findings: 2, blockers: 1 },
        { number: 2, head: second, findings: 0, blockers: 0 },
      ],
    },
  });

  // A replacement reviewer reads the recorded rounds in its brief.
  await exec(["herdr", "pane", "exit", (await shown(source)).launches[1]?.paneId ?? "", "w"]);
  expect(await entry(source)).toMatchObject({
    action: "replace_worker",
    reason: "worker_interrupted",
  });
  expect((await run(["dispatch", "--source", source, "--assignment", "implement"])).code).toBe(0);
  const brief = await Bun.file(worker.brief).text();
  expect(brief).toContain(
    `### Round 1 at \`${first}\`\n\n- Spec, blocker, \`a.ts:1\`:\n> The guard is missing.`,
  );
  expect(brief).toContain(`### Round 2 at \`${second}\``);
  expect(brief).toContain("Phase: `ready`");
}, 180000);

async function herdrFail(fail: Record<string, string>) {
  const file = Bun.file(`${root}/herdr-state.json`);
  const state = z.looseObject({}).parse(await file.json());
  await Bun.write(file, JSON.stringify({ ...state, fail }));
}
