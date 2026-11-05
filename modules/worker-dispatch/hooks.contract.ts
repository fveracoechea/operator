import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { ok, startHerdrServer } from "../../scripts/live-contract-fixture.ts";
import { Herdr } from "../herdr/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { eventSchema } from "./hooks.ts";
import { pluginManifestFile } from "./plugin.ts";

// A live contract: the released plugin manifest, linked into a private Herdr server, with each
// hook command replaced by a recorder of the event and the environment Herdr gives it.
const manifest = z
  .object({
    min_herdr_version: z.string(),
    events: z.array(z.object({ on: z.string(), command: z.array(z.string()) })),
  })
  .parse(Bun.TOML.parse(await Bun.file(pluginManifestFile).text()));
const recorded = z.object({ name: z.string(), json: z.string(), socket: z.string() });
let server: Awaited<ReturnType<typeof startHerdrServer>>;
let log: string;

beforeAll(async () => {
  server = await startHerdrServer();
  log = `${server.root}/events.jsonl`;
  const directory = `${server.root}/plugin`;
  await Bun.write(
    `${directory}/record.ts`,
    `const { appendFile } = await import("node:fs/promises");
await appendFile(${JSON.stringify(log)}, JSON.stringify({
  name: process.env.HERDR_PLUGIN_EVENT ?? "",
  json: process.env.HERDR_PLUGIN_EVENT_JSON ?? "",
  socket: process.env.HERDR_SOCKET_PATH ?? "",
}) + "\\n");
`,
  );
  const released = await Bun.file(pluginManifestFile).text();
  await Bun.write(
    `${directory}/herdr-plugin.toml`,
    released
      .replace(/^id = .*$/m, 'id = "operator-contract"')
      .replaceAll(
        /^command = .*$/gm,
        `command = ${JSON.stringify([process.execPath, `${directory}/record.ts`])}`,
      ),
  );
  await ok(Herdr.linkPlugin(directory));
});
afterAll(async () => {
  await server?.stop();
});

async function events(count: number) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const file = Bun.file(log);
    const lines = (await file.exists()) ? (await file.text()).split("\n").filter(Boolean) : [];
    if (lines.length >= count || Date.now() > deadline)
      return lines.map((line) => recorded.parse(JSON.parse(line)));
    await Bun.sleep(100);
  }
}

function herdr(...args: string[]) {
  return ToolInvocation.run({ tool: "herdr", args, timeoutMs: 30000 });
}

test("the installed herdr meets the plugin manifest's min_herdr_version", async () => {
  const result = await herdr("--version");
  const installed = result.status === "completed" ? result.stdout.trim().split(" ").at(-1) : "";
  expect(Bun.semver.satisfies(installed ?? "", `>=${manifest.min_herdr_version}`)).toBe(true);
});

test("herdr runs each plugin hook with the event fields and socket that Operator reads", async () => {
  const { repo } = server;
  const base = await ok(Herdr.createWorkspace({ cwd: repo, label: "events" }));
  const worktree = await ok(
    Herdr.createWorktree({ workspaceId: base.workspaceId, branch: "events", label: "events" }),
  );
  expect(
    await herdr(
      "pane",
      "report-agent",
      "--source",
      "contract",
      "--agent",
      "claude",
      "--state",
      "working",
      base.paneId,
    ),
  ).toMatchObject({ status: "completed", exitCode: 0 });
  const exiting = await ok(
    Herdr.createTab({ workspaceId: base.workspaceId, cwd: repo, label: "exit" }),
  );
  expect(await herdr("pane", "run", exiting.paneId, "exit")).toMatchObject({
    status: "completed",
    exitCode: 0,
  });
  const closing = await ok(
    Herdr.createTab({ workspaceId: base.workspaceId, cwd: repo, label: "close" }),
  );
  expect(await ok(Herdr.closePane(closing.paneId))).toBe("closed");

  const seen = await events(manifest.events.length);
  expect(seen.map((row) => row.name).toSorted()).toEqual(
    manifest.events.map((row) => row.on).toSorted(),
  );
  const parsed = new Map(
    seen.map((row) => [row.name, eventSchema.parse(JSON.parse(row.json)).data]),
  );
  expect(parsed.get("worktree.created")?.worktree?.path).toBe(worktree.path);
  expect(parsed.get("pane.agent_status_changed")).toMatchObject({
    pane_id: base.paneId,
    workspace_id: base.workspaceId,
    agent_status: "working",
  });
  expect(parsed.get("pane.exited")).toMatchObject({
    pane_id: exiting.paneId,
    workspace_id: base.workspaceId,
  });
  expect(parsed.get("pane.closed")).toMatchObject({
    pane_id: closing.paneId,
    workspace_id: base.workspaceId,
  });
  expect(new Set(seen.map((row) => row.socket))).toEqual(new Set([server.socket]));
});
