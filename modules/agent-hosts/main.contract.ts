import { afterAll, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory, real-path, or recursive removal API.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ok } from "../../scripts/live-contract-fixture.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { AgentHosts } from "./main.ts";
import { Herdr } from "../herdr/main.ts";
import { OkAsync } from "unthrown";
import { z } from "zod";

// Live host contracts send no prompts. The startup contract creates and deletes an empty session,
// replacing only Herdr's terminal launch so the API preserves the selection without paid generation.
const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "operator-hosts-")));
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Reads the host's model catalog, then checks that its launch command accepts each flag Operator passes. */
async function contract(host: "opencode" | "claude-code") {
  const models = await ok(AgentHosts.models({ host, cwd }));
  expect(models.length).toBeGreaterThan(0);
  const model = models.find((candidate) => candidate.efforts.length > 0);
  if (model === undefined) return expect.unreachable(`${host} advertises no model with an effort.`);
  const launch = await ok(
    AgentHosts.resolve({ host, cwd, model: model.model, reasoningEffort: model.efforts[0] ?? "" }),
  );
  const help = await ToolInvocation.run({
    tool: launch.command.tool,
    args: ["--help"],
    cwd,
    timeoutMs: 30000,
  });
  expect(help).toMatchObject({ status: "completed", exitCode: 0 });
  const text = help.status === "completed" ? help.stdout + help.stderr : "";
  for (const flag of launch.command.args.filter((arg) => arg.startsWith("--")))
    expect(text).toContain(flag);
  if (host === "opencode") expect(text).toContain("--session");
}

test("opencode api get /api/model answers the model catalog, and the full TUI takes --session", async () => {
  await contract("opencode");
}, 60000);

test("the Claude Agent SDK reads the claude model catalog, and claude takes --model and --effort", async () => {
  await contract("claude-code");
}, 60000);

test("OpenCode session creation selects the worker agent and preserves the model and effort before the full TUI attaches", async () => {
  const models = await ok(AgentHosts.models({ host: "opencode", cwd }));
  const model = models.find((candidate) => candidate.efforts.length > 0);
  if (model === undefined)
    return expect.unreachable("OpenCode advertises no model with an effort.");
  const launch = await ok(
    AgentHosts.resolve({
      host: "opencode",
      cwd,
      model: model.model,
      reasoningEffort: model.efforts[0] ?? "",
    }),
  );
  const start = spyOn(Herdr, "startAgent").mockReturnValue(OkAsync(null));
  let sessionID: string | undefined;
  try {
    await ok(AgentHosts.start({ launch, cwd, name: "contract", paneId: "not-a-real-pane" }));
    sessionID = start.mock.calls[0]?.[0].args[1];
    if (sessionID === undefined)
      return expect.unreachable("OpenCode did not provide a session ID.");
    expect(start).toHaveBeenCalledTimes(1);
    expect(sessionID).toMatch(/^ses/);
    expect(start.mock.calls[0]?.[0]).toEqual({
      name: "contract",
      paneId: "not-a-real-pane",
      kind: "opencode",
      args: ["--session", sessionID],
    });
    const session = await ToolInvocation.run({
      tool: "opencode",
      args: ["api", "get", `/api/session/${sessionID}`],
      cwd,
      timeoutMs: 30000,
    });
    expect(session).toMatchObject({ status: "completed", exitCode: 0 });
    if (session.status !== "completed")
      return expect.unreachable("OpenCode did not return the session.");
    const { data } = z
      .object({ data: z.object({ agent: z.string().optional() }) })
      .parse(JSON.parse(session.stdout));
    expect(data.agent).toBe("worker");
  } finally {
    start.mockRestore();
    if (sessionID !== undefined) {
      expect(
        await ToolInvocation.run({
          tool: "opencode",
          args: ["api", "delete", `/api/session/${sessionID}`],
          cwd,
          timeoutMs: 30000,
        }),
      ).toMatchObject({ status: "completed", exitCode: 0 });
    }
  }
}, 60000);
