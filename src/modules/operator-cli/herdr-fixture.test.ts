import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { fakeHerdrScript, retainHerdrTrace } from "./herdr-fixture.ts";

let root = "";
let script = "";
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
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
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
    held.stdin.end();
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
        ]),
      },
    });
  } finally {
    held.kill();
    await held.exited;
  }
});

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
  expect(records).toEqual(
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
    ]),
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
