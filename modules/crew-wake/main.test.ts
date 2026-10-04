import { afterEach, expect, test as bunTest } from "bun:test";
// Bun has no chmod, directory creation, directory listing, temporary directory, recursive removal,
// OS temp path, or path join API.
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewWake } from "./main.ts";

// A test runs the real hook, CLI, and operator path, which is up to ten bun starts in sequence.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "operator-wake-"));
  roots.push(root);
  const herdr = join(root, "herdr");
  const operator = join(root, "operator");
  // One wake runs Herdr up to four times. A sh fake starts in milliseconds, and a bun fake
  // can take seconds on a loaded machine.
  await Bun.write(
    herdr,
    `#!/bin/sh
set -u
if [ "$*" = "plugin config-dir operator.wake" ]; then
  printf '%s\\n' "$WAKE_CONFIG"
elif [ "\${1:-} \${2:-}" = "agent list" ]; then
  crew=',{"pane_id":"w1:p2","terminal_id":"terminal-2","agent":"opencode","name":"'"\${WAKE_CREW_NAME:-operative}"'","agent_status":"done"}'
  [ -n "\${WAKE_CREW_GONE:-}" ] && crew=''
  printf '{"result":{"agents":[{"pane_id":"%s","terminal_id":"terminal-1","agent":"%s","name":null,"agent_status":"%s","agent_session":{"kind":"id","value":"session-1"}}%s]}}\\n' "\${WAKE_OPERATOR_PANE:-w1:p1}" "\${WAKE_HOST:-opencode}" "\${WAKE_STATUS:-idle}" "$crew"
elif [ "\${1:-} \${2:-}" = "agent prompt" ]; then
  if [ -n "\${WAKE_PROMPT_FAIL:-}" ]; then
    printf '%s\\n' '{"error":{"code":"unavailable","message":"not delivered"}}' >&2
    exit 1
  fi
  printf '%s\\n' "$*" >> "$WAKE_PROMPTS"
  printf '%s\\n' '{"result":{"type":"agent_prompt"}}'
elif [ "\${1:-} \${2:-}" = "pane get" ]; then
  # Only the moved pane maps to the crew terminal, so an exit of the armed pane must match
  # the recorded pane.
  case "\${3:-}" in w2:p9) terminal=terminal-2 ;; *) terminal=unrelated ;; esac
  printf '{"result":{"pane":{"terminal_id":"%s"}}}\\n' "$terminal"
else
  printf 'unexpected herdr call: %s\\n' "$*" >&2
  exit 1
fi
`,
  );
  await Bun.write(
    operator,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.join(" ") !== (process.env.WAKE_EXPECTED_NEXT ?? "crew next --opencode --json")) throw new Error("unexpected operator call: " + args.join(" "));
appendFileSync(process.env.WAKE_CALLS, "next\\n");
const calls = readFileSync(process.env.WAKE_CALLS, "utf8").split("\\n").filter(Boolean).length;
// From call WAKE_LATE_FROM on, the schedule has an action and can have another owner.
const late = process.env.WAKE_LATE_FROM !== undefined && calls >= Number(process.env.WAKE_LATE_FROM);
if (process.env.WAKE_BARRIER) {
  // Each wake check waits here until two checks hold the armed binding.
  writeFileSync(process.env.WAKE_BARRIER + "/" + process.pid, "");
  const until = Date.now() + 30_000;
  while (readdirSync(process.env.WAKE_BARRIER).length < 2 && Date.now() < until) await Bun.sleep(20);
}
const action = process.env.WAKE_ACTION === "yes" || late;
const blocker = process.env.WAKE_BLOCKER === "yes";
const owner = (late && process.env.WAKE_LATE_OWNER) || (process.env.WAKE_OWNER ?? "owner-1");
console.log(JSON.stringify({ data: { ownership: { ownerLabel: owner, acquiredAt: "today", revision: Number(process.env.WAKE_REVISION ?? 1) }, actions: action ? [{ action: "accept_assignment", blocker: null }] : blocker ? [{ action: "answer_question", blocker: "escalation_required" }] : [], waits: action || blocker ? [] : [{ attemptId: "attempt-1", agentName: process.env.WAKE_CREW_NAME ?? "operative" }] } }));
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
    WAKE_CALLS: join(root, "calls"),
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

test("a working Operator, an unrelated event, and a changed owner cannot wake it", async () => {
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
  expect((await f.run("event", event)).exitCode).toBe(0);
  expect(
    (
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
      })
    ).exitCode,
  ).toBe(0);
  // A changed owner makes the binding stale, so this event runs last.
  expect(
    (await f.run("event", { ...event, WAKE_STATUS: "idle", WAKE_OWNER: "another-owner" })).exitCode,
  ).toBe(0);
  expect(await f.prompts()).toBe("");
});

test("a crew event cannot wake the Operator when crew next has only waits", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const event = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: { type: "pane_agent_status_changed", pane_id: "w1:p2", agent_status: "done" },
    }),
    WAKE_STATUS: "idle",
    // With no action and no blocker, the fake crew next returns only a wait.
    WAKE_ACTION: "",
  };
  expect((await f.run("event", event)).exitCode).toBe(0);
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

test("a refusal in the config directory answer of Herdr is refused, and nothing is written", async () => {
  const f = await fixture();
  // Herdr reports a refused request in the body, with exit 0.
  const refusal = '{"error":{"code":"unsupported_method","message":"no config directory"}}';
  const before = await readdir(f.root);

  const armed = await f.run("arm", { HERDR_PLUGIN_CONFIG_DIR: "", WAKE_CONFIG: refusal });

  expect(armed.exitCode).not.toBe(0);
  expect(JSON.parse(armed.stdout).reason).toBe("wake_failed");
  // `calls` is the log of the fake operator, which the arm reads before the directory.
  expect((await readdir(f.root)).filter((name) => name !== "calls")).toEqual(before);
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

const crewDone = JSON.stringify({
  event: "pane.agent_status_changed",
  data: { type: "pane_agent_status_changed", pane_id: "w1:p2", agent_status: "done" },
});

test("a changed owner makes the binding stale, so the first owner cannot wake it later", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const event = { HERDR_PLUGIN_EVENT_JSON: crewDone, WAKE_STATUS: "idle", WAKE_ACTION: "yes" };
  expect((await f.run("event", { ...event, WAKE_OWNER: "another-owner" })).exitCode).toBe(0);
  expect((await f.run("event", event)).exitCode).toBe(0);
  expect(await f.prompts()).toBe("");
});

test("a working status event is not relevant", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const result = await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: "pane.agent_status_changed",
      data: { type: "pane_agent_status_changed", pane_id: "w1:p2", agent_status: "working" },
    }),
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
  });
  expect(result.exitCode).toBe(0);
  expect(await f.prompts()).toBe("");
});

test("an agent in the crew pane with another name is not the crew agent", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const result = await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: crewDone,
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
    WAKE_CREW_NAME: "intruder",
  });
  expect(result.exitCode).toBe(0);
  expect(await f.prompts()).toBe("");
});

test("a crew event reads crew next again until the crew report arrives", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  // Call 1 was the arm. Call 2 of the event has only a wait, and call 3 has the action.
  const result = await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: crewDone,
    WAKE_STATUS: "idle",
    WAKE_LATE_FROM: "3",
  });
  expect(result.exitCode).toBe(0);
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

test("an owner change found on a later read of crew next cannot wake the Operator", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const result = await f.run("event", {
    HERDR_PLUGIN_EVENT_JSON: crewDone,
    WAKE_STATUS: "idle",
    WAKE_LATE_FROM: "3",
    WAKE_LATE_OWNER: "another-owner",
  });
  expect(result.exitCode).toBe(0);
  expect(await f.prompts()).toBe("");
});

test("two events that hold the armed binding at the same time send one prompt", async () => {
  const f = await fixture();
  expect((await f.run("arm")).exitCode).toBe(0);
  const barrier = join(f.root, "barrier");
  await mkdir(barrier);
  const event = {
    HERDR_PLUGIN_EVENT_JSON: crewDone,
    WAKE_STATUS: "idle",
    WAKE_ACTION: "yes",
    WAKE_BARRIER: barrier,
  };
  const results = await Promise.all([f.run("event", event), f.run("event", event)]);
  expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
  expect((await f.prompts()).split("\n").filter(Boolean)).toHaveLength(1);
});

const binding = { owner: "owner-1", acquired: "today", revision: 1 };
const idle = {
  pane_id: "w1:p1",
  terminal_id: "terminal-1",
  agent: "opencode",
  agent_status: "idle",
  agent_session: { kind: "id", value: "session-1" },
};
const owned = { ownerLabel: "owner-1", acquiredAt: "today", revision: 1 };
const withAction = {
  ownership: owned,
  actions: [{ action: "accept_assignment", blocker: null }],
  waits: [],
};
const withWait = {
  ownership: owned,
  actions: [],
  waits: [{ agentName: "operative", attemptId: "attempt-1" }],
};

test("the wake binding asks for each fact in guard order before it decides", () => {
  const event = { kind: "herdr-event", binding, pane: "w1:p2" } as const;
  expect(CrewWake.decide("armed", event, {})).toEqual({ needs: "operator" });
  expect(CrewWake.decide("armed", event, { operator: idle })).toEqual({ needs: "schedule" });
  expect(CrewWake.decide("armed", event, { operator: idle, schedule: withWait })).toEqual({
    needs: "crewEvent",
  });
  // A startup check has no event, so it never asks whether an event is relevant.
  expect(
    CrewWake.decide("armed", { kind: "check", binding }, { operator: idle, schedule: withWait }),
  ).toEqual({ needs: "settled" });
});

test("a checked binding is submitted once, and only from armed", () => {
  const facts = {
    operator: idle,
    schedule: withWait,
    crewEvent: true,
    settled: withAction,
    current: idle,
  };
  const event = { kind: "herdr-event", binding, pane: "w1:p2" } as const;
  expect(CrewWake.decide("armed", event, facts)).toEqual({
    next: "submitted",
    effects: [{ kind: "prompt", pane: "w1:p1" }],
  });
  for (const state of ["absent", "submitted", "stale"] as const) {
    expect(CrewWake.decide(state, event, facts)).toEqual({ refused: "not-armed" });
  }
});

test("a changed owner makes an armed binding stale, and a later change refuses", () => {
  const facts = { operator: idle, schedule: { ...withWait, ownership: null } };
  expect(CrewWake.decide("armed", { kind: "check", binding }, facts)).toEqual({
    next: "stale",
    effects: [],
  });
  // An owner change found only after the late report is a refusal, not a stale binding.
  expect(
    CrewWake.decide(
      "armed",
      { kind: "check", binding },
      { ...facts, schedule: withWait, settled: { ...withAction, ownership: null } },
    ),
  ).toEqual({ refused: "no-crew-action" });
});

test("an event from an unrelated pane and a busy Operator are refused", () => {
  const event = { kind: "herdr-event", binding, pane: "w1:p3" } as const;
  expect(
    CrewWake.decide("armed", event, { operator: idle, schedule: withWait, crewEvent: false }),
  ).toEqual({ refused: "unrelated-event" });
  expect(CrewWake.decide("armed", event, { operator: undefined })).toEqual({
    refused: "operator-busy",
  });
});

test("an arm needs a working Operator that owns a crew with waits and no action", () => {
  const caller = { ...idle, agent_status: "working" };
  const arm = { kind: "arm", owner: "owner-1" } as const;
  expect(CrewWake.decide("stale", arm, { caller: idle })).toEqual({ refused: "not-operator" });
  expect(CrewWake.decide("stale", arm, { caller, schedule: withAction })).toEqual({
    refused: "no-crew-wait",
  });
  expect(CrewWake.decide("submitted", arm, { caller, schedule: withWait })).toMatchObject({
    next: "armed",
    effects: [{ kind: "arm", session: "session-1", acquired: "today", revision: 1 }],
  });
});

// A named departure of #151: a missing Herdr binary is named by the tool, not by the Bun spawn
// error, and nothing is requested.
test("a wake with no Herdr binary names the missing tool and requests nothing", async () => {
  const f = await fixture();
  const absent = join(f.root, "absent-herdr");

  const armed = await f.run("arm", { HERDR_BIN_PATH: absent });

  expect(armed.exitCode).not.toBe(0);
  expect(JSON.parse(armed.stdout)).toEqual({
    schemaVersion: 1,
    outcome: "failed",
    reason: "wake_failed",
    blockers: [
      {
        reason: "wake_failed",
        message: `Error: ${absent} is not on the path, so nothing was requested.`,
      },
    ],
    operation: "wake_arm",
  });
  expect(await f.prompts()).toBe("");
});
