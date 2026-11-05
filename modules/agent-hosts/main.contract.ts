import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory, real-path, or recursive removal API.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ok } from "../../scripts/live-contract-fixture.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { AgentHosts } from "./main.ts";

// A live contract: each test reads the installed host. No test sends a prompt or starts a session.
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
  const subcommand = launch.command.args.filter((arg) => !arg.startsWith("-")).slice(0, 1);
  const help = await ToolInvocation.run({
    tool: launch.command.tool,
    args: [...(host === "opencode" ? subcommand : []), "--help"],
    cwd,
    timeoutMs: 30000,
  });
  expect(help).toMatchObject({ status: "completed", exitCode: 0 });
  const text = help.status === "completed" ? help.stdout + help.stderr : "";
  for (const flag of launch.command.args.filter((arg) => arg.startsWith("--")))
    expect(text).toContain(flag);
}

test("opencode api get /api/model answers the model catalog, and opencode mini takes --model", async () => {
  await contract("opencode");
}, 60000);

test("the Claude Agent SDK reads the claude model catalog, and claude takes --model and --effort", async () => {
  await contract("claude-code");
}, 60000);
