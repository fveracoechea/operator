import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { fakeHerdrScript, retainHerdrTrace } from "./herdr-fixture.ts";

let root = "";
let script = "";
const topologySchema = z.looseObject({
  counter: z.number(),
  workspaces: z.array(z.looseObject({ workspace_id: z.string() })),
  tabs: z.array(z.looseObject({ workspaceId: z.string(), tabId: z.string(), paneId: z.string() })),
  agents: z.array(z.looseObject({ name: z.string(), paneId: z.string() })),
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-herdr-control-"));
  script = `${root}/herdr.ts`;
  await Bun.write(script, fakeHerdrScript(root));
  await Bun.write(
    `${root}/herdr-state.json`,
    JSON.stringify({
      counter: 6,
      plugins: [],
      agents: [],
      workspaces: [
        { workspace_id: "w1", worktree: { checkout_path: root, is_linked_worktree: false } },
      ],
      tabs: [
        { workspaceId: "w3", tabId: "w3:t4", paneId: "w3:p4", label: "PRIVATE_LABEL" },
        { workspaceId: "w5", tabId: "w5:t6", paneId: "w5:p6", label: "child" },
      ],
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function start(file: string, args: string[]) {
  return Bun.spawn([process.execPath, file, ...args], {
    env: { HOME: root, PATH: "", OPENCODE_SESSION_ID: "PRIVATE_SESSION" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
}

async function run(...args: string[]) {
  const child = start(script, args);
  await child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function controlled(...args: string[]) {
  const ready = Promise.withResolvers<unknown>();
  const child = Bun.spawn([process.execPath, script, ...args], {
    env: { HOME: root, PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
    ipc(message) {
      ready.resolve(message);
    },
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  void child.exited.then(() => ready.reject(new Error("fixture exited before acknowledgment")));
  return { child, ready: ready.promise, stdout, stderr };
}

async function traceOrder() {
  return (await Bun.file(`${root}/herdr-topology.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => {
      const { command, phase } = z
        .object({ command: z.string(), phase: z.string() })
        .parse(JSON.parse(line));
      return [command, phase];
    });
}

test("a held cleanup pane read does not erase a replacement tab", async () => {
  const heldScript = `${root}/held-herdr.ts`;
  const source = fakeHerdrScript(root);
  const marker = "const save =";
  expect(source.split(marker)).toHaveLength(2);
  // Hold the cleanup's loaded snapshot with a pipe, not a scheduler-dependent delay.
  await Bun.write(
    heldScript,
    source.replace(
      marker,
      'console.log("CONTROL_READY"); await new Response(Bun.stdin).text();\n' + marker,
    ),
  );
  const held = start(heldScript, ["pane", "get", "w3:p4"]);
  try {
    const reader = held.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("CONTROL_READY");
    const opened = await run(
      "worktree",
      "open",
      "--workspace",
      "w1",
      "--path",
      root,
      "--label",
      "child",
    );
    expect(opened.code, opened.stderr).toBe(0);
    const placed = z
      .object({ result: z.object({ root_pane: z.object({ tab_id: z.string() }) }) })
      .parse(JSON.parse(opened.stdout)).result.root_pane;
    expect(placed.tab_id).toBe("w7:t8");
    await held.stdin.end();
    while (!(await reader.read()).done) {
      // Drain the bounded controlled reply before checking the exit.
    }
    expect(await held.exited).toBe(0);
    const renamed = await run("tab", "rename", placed.tab_id, "child");
    expect(renamed.code, renamed.stdout + renamed.stderr).toBe(0);
    const panes = await run("pane", "list");
    expect(JSON.parse(panes.stdout)).toMatchObject({
      result: {
        panes: expect.arrayContaining([
          { pane_id: "w7:p8", tab_id: "w7:t8", workspace_id: "w7", cwd: root },
        ]) as unknown,
      },
    });
  } finally {
    held.kill();
    await held.exited;
  }
});

test("a held cleanup pane close does not erase a replacement tab after its hook", async () => {
  const stateFile = Bun.file(`${root}/herdr-state.json`);
  const initial = topologySchema.parse(await stateFile.json());
  initial.workspaces.push(
    { workspace_id: "w3", worktree: { checkout_path: `${root}/parent`, is_linked_worktree: true } },
    { workspace_id: "w5", worktree: { checkout_path: `${root}/child`, is_linked_worktree: true } },
  );
  initial.agents = [
    { name: "parent", paneId: "w3:p4" },
    { name: "child", paneId: "w5:p6" },
  ];
  await Bun.write(stateFile, JSON.stringify(initial));
  const source = fakeHerdrScript(root);
  const marker = "async function hook(event, data) {";
  expect(source.split(marker)).toHaveLength(2);
  await Bun.write(
    script,
    source.replace(
      marker,
      marker +
        '\nif (event === "pane.closed") { await new Promise(resolve => { process.once("message", resolve); process.send("CLOSE_SAVED"); }); process.disconnect(); }',
    ),
  );
  const held = controlled("pane", "close", "w3:p4");
  try {
    expect(await held.ready).toBe("CLOSE_SAVED");
    const opened = await run("worktree", "open", "--workspace", "w1", "--path", root);
    expect(opened.code, opened.stdout + opened.stderr).toBe(0);
    expect(JSON.parse(opened.stdout)).toMatchObject({
      result: { root_pane: { tab_id: "w7:t8", pane_id: "w7:p8" } },
    });
    held.child.send("RELEASE_CLOSE");
    expect(await held.child.exited, (await held.stdout) + (await held.stderr)).toBe(0);
    const renamed = await run("tab", "rename", "w7:t8", "replacement");
    expect(renamed.code, renamed.stdout + renamed.stderr).toBe(0);
    const final = topologySchema.parse(await stateFile.json());
    expect(final.counter).toBe(8);
    expect<unknown>(final.tabs).toEqual([
      initial.tabs[1],
      { workspaceId: "w7", tabId: "w7:t8", paneId: "w7:p8", label: "replacement", cwd: root },
    ]);
    expect<unknown>(final.workspaces).toEqual([
      initial.workspaces[0],
      initial.workspaces[2],
      {
        workspace_id: "w7",
        label: "workspace",
        worktree: { checkout_path: root, is_linked_worktree: true },
      },
    ]);
    expect<unknown>(final.agents).toEqual([initial.agents[1]]);
    expect(await traceOrder()).toEqual([
      ["pane close", "loaded"],
      ["pane close", "save-start"],
      ["pane close", "save-end"],
      ["worktree open", "loaded"],
      ["worktree open", "save-start"],
      ["worktree open", "save-end"],
      ["tab rename", "loaded"],
      ["tab rename", "save-start"],
      ["tab rename", "save-end"],
    ]);
  } catch (error) {
    console.error(await Bun.file(`${root}/herdr-topology.jsonl`).text());
    // oxlint-disable-next-line unthrown/no-throw -- Preserve the original test failure after printing controlled diagnostics.
    throw error;
  } finally {
    held.child.kill();
    await held.child.exited;
  }
});

test.each([false, true])(
  "fixture mutations serialize before loading, interrupted holder: %s",
  async (interrupt) => {
    const source = fakeHerdrScript(root);
    const loaded = 'trace("loaded");';
    const acquire = 'lock.run("BEGIN IMMEDIATE");';
    expect(source.split(loaded)).toHaveLength(2);
    expect(source.split(acquire)).toHaveLength(2);
    // A failed acquisition acknowledges real contention, not just process startup.
    // Only this control uses a zero busy timeout and an IPC-gated second acquisition.
    await Bun.write(
      script,
      source
        .replace("PRAGMA busy_timeout = 5000", "PRAGMA busy_timeout = 0")
        .replace(
          acquire,
          `try { ${acquire} } catch (error) {
      if (error.code !== "SQLITE_BUSY") throw error;
      await new Promise(resolve => { process.once("message", resolve); process.send("WRITER_BLOCKED"); });
      process.disconnect(); ${acquire}
    }`,
        )
        .replace(
          loaded,
          loaded +
            `
      if (key === "pane close") {
        await new Promise(resolve => { process.once("message", resolve); process.send("CLOSE_LOADED"); });
        process.disconnect();
      }`,
        ),
    );
    const initial = topologySchema.parse(await Bun.file(`${root}/herdr-state.json`).json());
    const close = controlled("pane", "close", "w3:p4");
    let open: ReturnType<typeof controlled> | undefined;
    try {
      expect(await close.ready).toBe("CLOSE_LOADED");
      open = controlled("worktree", "open", "--workspace", "w1", "--path", root);
      expect(await open.ready).toBe("WRITER_BLOCKED");
      expect(await traceOrder()).toEqual([["pane close", "loaded"]]);
      expect((await run("pane", "get", "w5:p6")).code).toBe(0);
      if (interrupt) close.child.kill("SIGKILL");
      else close.child.send("RELEASE_CLOSE");
      const code = await close.child.exited;
      if (interrupt) expect(code).not.toBe(0);
      else expect(code, (await close.stdout) + (await close.stderr)).toBe(0);
      open.child.send("RETRY_ACQUIRE");
      expect(await open.child.exited, (await open.stdout) + (await open.stderr)).toBe(0);
      expect(JSON.parse(await open.stdout)).toMatchObject({
        result: { root_pane: { tab_id: "w7:t8" } },
      });
      const renamed = await run("tab", "rename", "w7:t8", "replacement");
      expect(renamed.code, renamed.stdout + renamed.stderr).toBe(0);
      const final = topologySchema.parse(await Bun.file(`${root}/herdr-state.json`).json());
      expect<unknown>(final.tabs).toEqual([
        ...(interrupt ? initial.tabs : [initial.tabs[1]]),
        { workspaceId: "w7", tabId: "w7:t8", paneId: "w7:p8", label: "replacement", cwd: root },
      ]);
      expect(final.workspaces[0]).toEqual(initial.workspaces[0]);
      expect(final.counter).toBe(8);
      expect(await traceOrder()).toEqual([
        ["pane close", "loaded"],
        ["pane get", "loaded"],
        ...(interrupt
          ? []
          : [
              ["pane close", "save-start"],
              ["pane close", "save-end"],
            ]),
        ["worktree open", "loaded"],
        ["worktree open", "save-start"],
        ["worktree open", "save-end"],
        ["tab rename", "loaded"],
        ["tab rename", "save-start"],
        ["tab rename", "save-end"],
      ]);
    } catch (error) {
      console.error(await Bun.file(`${root}/herdr-topology.jsonl`).text());
      // oxlint-disable-next-line unthrown/no-throw -- Preserve the original test failure after printing controlled diagnostics.
      throw error;
    } finally {
      close.child.kill();
      open?.child.kill();
      await Promise.all([close.child.exited, open?.child.exited]);
    }
  },
);

test("controlled topology evidence records missing tabs without labels, prompts, or host sessions", async () => {
  expect((await run("agent", "prompt", "PRIVATE_AGENT", "PRIVATE_PROMPT")).code).toBe(0);
  expect((await run("tab", "rename", "w7:t8", "PRIVATE_RENAME")).code).toBe(1);
  const trace = await Bun.file(`${root}/herdr-topology.jsonl`).text();
  for (const secret of [
    "PRIVATE_LABEL",
    "PRIVATE_SESSION",
    "PRIVATE_AGENT",
    "PRIVATE_PROMPT",
    "PRIVATE_RENAME",
  ])
    expect(trace).not.toContain(secret);
  const records = trace
    .trim()
    .split("\n")
    .map((line) =>
      z.looseObject({ command: z.string(), phase: z.string() }).parse(JSON.parse(line)),
    );
  expect(records.map(({ command, phase }) => [command, phase])).toEqual([
    ["agent prompt", "loaded"],
    ["agent prompt", "save-start"],
    ["agent prompt", "save-end"],
    ["tab rename", "loaded"],
    ["tab rename", "tab-not-found"],
  ]);
  expect<unknown>(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "loaded",
        command: "agent prompt",
        fixture: root,
        session: `${root}/herdr.sock`,
      }),
      expect.objectContaining({ phase: "save-start", command: "agent prompt" }),
      expect.objectContaining({ phase: "save-end", command: "agent prompt" }),
      expect.objectContaining({
        phase: "tab-not-found",
        command: "tab rename",
        target: "w7:t8",
        counter: 6,
        tabs: [
          { tabId: "w3:t4", paneId: "w3:p4", workspaceId: "w3" },
          { tabId: "w5:t6", paneId: "w5:p6", workspaceId: "w5" },
        ],
      }),
    ]) as unknown,
  );
});

test("controlled topology evidence stays bounded and survives device cleanup", async () => {
  expect(await retainHerdrTrace(root)).toBeNull();
  const file = `${root}/herdr-topology.jsonl`;
  const text = "x".repeat(262144);
  await Bun.write(file, text);
  expect((await run("pane", "list")).code).toBe(0);
  expect(await Bun.file(file).text()).toBe(text);
  const evidence = await retainHerdrTrace(root);
  expect(evidence).not.toBeNull();
  if (evidence === null) return;
  try {
    expect(evidence.tail).toBe("x".repeat(16384));
    expect(await Bun.file(evidence.file).text()).toBe(text);
    await rm(root, { recursive: true, force: true });
    expect(await Bun.file(evidence.file).text()).toBe(text);
  } finally {
    await rm(path.dirname(evidence.file), { recursive: true, force: true });
  }
});
