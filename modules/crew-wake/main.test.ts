import { afterEach, expect, test } from "bun:test";
// Bun has no chmod, temporary directory, recursive removal, OS temp path, or path join API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "operator-wake-"));
  roots.push(root);
  const herdr = join(root, "herdr");
  const operator = join(root, "operator");
  await Bun.write(
    herdr,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.join(" ") === "plugin config-dir operator.wake") {
  console.log(process.env.WAKE_CONFIG);
} else if (args[0] === "agent" && args[1] === "list") {
  console.log(JSON.stringify({ result: { agents: [{ pane_id: process.env.WAKE_OPERATOR_PANE ?? "w1:p1", terminal_id: "terminal-1", agent: process.env.WAKE_HOST ?? "opencode", name: null, agent_status: process.env.WAKE_STATUS ?? "idle", agent_session: { kind: "id", value: "session-1" } }, ...(process.env.WAKE_CREW_GONE ? [] : [{ pane_id: "w1:p2", terminal_id: "terminal-2", agent: "opencode", name: process.env.WAKE_CREW_NAME ?? "operative", agent_status: "done" }])] } }));
} else if (args[0] === "agent" && args[1] === "prompt") {
  if (process.env.WAKE_PROMPT_FAIL) { console.error(JSON.stringify({ error: { code: "unavailable", message: "not delivered" } })); process.exit(1); }
  await Bun.write(process.env.WAKE_PROMPTS, (await Bun.file(process.env.WAKE_PROMPTS).exists() ? await Bun.file(process.env.WAKE_PROMPTS).text() : "") + JSON.stringify(args) + "\\n");
  console.log(JSON.stringify({ result: { type: "agent_prompt" } }));
} else if (args[0] === "pane" && args[1] === "get") {
  console.log(JSON.stringify({ result: { pane: { terminal_id: args[2] === "w2:p9" || args[2] === "w1:p2" ? "terminal-2" : "unrelated" } } }));
} else { throw new Error("unexpected herdr call: " + args.join(" ")); }
`,
  );
  await Bun.write(
    operator,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.join(" ") !== (process.env.WAKE_EXPECTED_NEXT ?? "crew next --opencode --json")) throw new Error("unexpected operator call: " + args.join(" "));
const action = process.env.WAKE_ACTION === "yes";
const blocker = process.env.WAKE_BLOCKER === "yes";
console.log(JSON.stringify({ data: { ownership: { ownerLabel: process.env.WAKE_OWNER ?? "owner-1", acquiredAt: "today", revision: Number(process.env.WAKE_REVISION ?? 1) }, actions: action ? [{ action: "accept_assignment", blocker: null }] : blocker ? [{ action: "answer_question", blocker: "escalation_required" }] : [], waits: action || blocker ? [] : [{ attemptId: "attempt-1", agentName: process.env.WAKE_CREW_NAME ?? "operative" }] } }));
process.exit(action ? 0 : blocker ? 3 : 6);
`,
  );
  await chmod(herdr, 0o755);
  await chmod(operator, 0o755);
  const env = {
    ...process.env,
    HERDR_BIN_PATH: herdr,
    HERDR_PANE_ID: "w1:p1",
    WAKE_CONFIG: root,
    WAKE_PROMPTS: join(root, "prompts"),
    WAKE_STATUS: "working",
  };
  async function run(mode: string, overrides: Record<string, string> = {}) {
    const selection = overrides.WAKE_SELECTION ? ["--operator-host", overrides.WAKE_SELECTION] : [];
    const armArgs = [
      "wake",
      "arm",
      "--owner-label",
      "owner-1",
      "--opencode",
      ...selection,
      "--operator-bin",
      operator,
      "--json",
    ];
    const cliPath = join(import.meta.dir, "../../cli.ts");
    const args =
      mode === "arm"
        ? ["bun", cliPath, ...armArgs]
        : mode === "arm-eval"
          ? [
              "bun",
              "-e",
              `const { main } = await import(${JSON.stringify(cliPath)}); await main(Bun.argv.slice(1));`,
              "--",
              ...armArgs,
            ]
          : ["bun", join(import.meta.dir, "../../herdr/wake.ts"), mode];
    const process = Bun.spawn(args, {
      cwd: root,
      env: { ...env, HERDR_PLUGIN_CONFIG_DIR: root, ...overrides },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
  return {
    root,
    env,
    run,
    prompts: async () =>
      (await Bun.file(env.WAKE_PROMPTS).exists()) ? Bun.file(env.WAKE_PROMPTS).text() : "",
  };
}

test("an Operative change wakes the bound idle Operator once when crew next has work", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const event = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: {
        type: "pane_agent_status_changed",
        pane_id: "w1:p2",
        agent_status: "done",
      },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
  };
  expect((await f.run("event", event)).exitCode).toBe(0);
  expect((await f.run("event", event)).exitCode).toBe(0);
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
  expect(await f.prompts()).toContain("Run operator crew next");
});

test("a reviewer change can wake a Claude Code Operator after restart", async () => {
  const f = await fixture();
  expect((await f.run("arm", { WAKE_HOST: "claude", WAKE_CREW_NAME: "reviewer" })).exitCode).toBe(
    0,
  );
  expect(
    (
      await f.run("startup", {
        WAKE_HOST: "claude",
        WAKE_CREW_NAME: "reviewer",
        WAKE_STATUS: "idle",
        WAKE_ACTION: "yes",
        WAKE_OPERATOR_PANE: "w2:p4",
      })
    ).exitCode,
  ).toBe(0);
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

test("a working Operator, changed owner, and unrelated event cannot wake it", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const event = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: {
        type: "pane_agent_status_changed",
        pane_id: "w1:p2",
        agent_status: "done",
      },
    }),
    WAKE_ACTION: "yes",
  };
  await f.run("event", event);
  await f.run("event", { ...event, WAKE_STATUS: "idle", WAKE_OWNER: "another-owner" });
  await f.run("event", {
    ...event,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: {
        type: "pane_agent_status_changed",
        pane_id: "w1:p3",
        agent_status: "done",
      },
    }),
    WAKE_STATUS: "idle",
  });
  expect(await f.prompts()).toBe("");
});

test("an event received during user steering is checked when the Operator becomes idle", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: {
        type: "pane_agent_status_changed",
        pane_id: "w1:p2",
        agent_status: "done",
      },
    }),
    WAKE_ACTION: "yes",
  });
  expect(await f.prompts()).toBe("");
  await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: {
        type: "pane_agent_status_changed",
        pane_id: "w1:p1",
        agent_status: "idle",
      },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
  });
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

test("a crew process exit wakes the Operator after its agent disappears", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.exited",
      data: { type: "pane_exited", pane_id: "w1:p2" },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
    WAKE_CREW_GONE: "yes",
  });
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

test("an exit after a crew pane move still reaches the bound Operator", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.exited",
      data: { type: "pane_exited", pane_id: "w2:p9" },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
    WAKE_CREW_GONE: "yes",
  });
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

test("a blocker for the user wakes the Operator after a missed crew event", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const result = await f.run("startup", { WAKE_STATUS: "idle", WAKE_BLOCKER: "yes" });
  expect(result.exitCode).toBe(0);
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

test("a failed prompt is reported once and not resubmitted on startup", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const event = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: { type: "pane_agent_status_changed", pane_id: "w1:p2", agent_status: "done" },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
    WAKE_PROMPT_FAIL: "yes",
  };
  expect((await f.run("event", event)).exitCode).toBe(1);
  expect((await f.run("startup", { WAKE_STATUS: "idle", WAKE_ACTION: "yes" })).exitCode).toBe(0);
  expect(await f.prompts()).toBe("");
});

test("the registry eval launcher records the release CLI for a later wake", async () => {
  const f = await fixture();
  expect((await f.run("arm-eval")).exitCode).toBe(0);
  const event = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: { type: "pane_agent_status_changed", pane_id: "w1:p2", agent_status: "done" },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
  };
  expect((await f.run("event", event)).exitCode).toBe(0);
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

test("a wake reads the same explicit host selection that the Operator armed", async () => {
  const f = await fixture();
  const expected = "crew next --opencode --operator-host claude-code --json";
  expect(
    (await f.run("arm", { WAKE_SELECTION: "claude-code", WAKE_EXPECTED_NEXT: expected })).exitCode,
  ).toBe(0);
  const event = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: { type: "pane_agent_status_changed", pane_id: "w1:p2", agent_status: "done" },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
    WAKE_EXPECTED_NEXT: expected,
  };
  expect((await f.run("event", event)).exitCode).toBe(0);
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});
