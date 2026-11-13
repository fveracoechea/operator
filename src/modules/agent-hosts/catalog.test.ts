import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, real-path, or chmod API.
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Environment } from "../environment/main.ts";
import { discoverOpenCode, discoverClaude } from "./catalog.ts";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-agent-hosts-")));
const modulePath = new URL("./catalog.ts", import.meta.url).pathname;
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A controlled `claude` that answers the SDK initialize request with `reply` and records its run. */
async function controlledClaude(name: string, reply: string) {
  const directory = `${root}/${name}`;
  await Bun.write(
    `${directory}/bin/claude`,
    `#!${process.execPath}
await Bun.write(${JSON.stringify(`${directory}/run.json`)}, JSON.stringify({ args: Bun.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }));
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
  for (const line of chunk.trim().split("\\n")) {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      ${reply}
    }
  }
}
await Bun.write(${JSON.stringify(`${directory}/closed`)}, "closed");
`,
    { createPath: true },
  );
  await chmod(`${directory}/bin/claude`, 0o755);
  await Bun.write(`${directory}/work/.keep`, "");
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: `${directory}/bin` });
  return directory;
}

type ClaudeModel = {
  value: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};
type ControlResponse =
  | { subtype: "success"; response: { models: ClaudeModel[]; commands: []; agents: [] } }
  | { subtype: "error"; error: string };

function answer(response: ControlResponse) {
  return `console.log(JSON.stringify({ type: "control_response", response: { ...${JSON.stringify(response)}, request_id: message.request_id } }));`;
}

function models(list: ClaudeModel[]) {
  return answer({ subtype: "success", response: { models: list, commands: [], agents: [] } });
}

function refusal(error: string) {
  return answer({ subtype: "error", error });
}

test("uses directory-scoped OpenCode metadata and omits disabled models", async () => {
  const run = spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      location: { directory: "/isolated dir" },
      data: [
        { providerID: "provider", id: "selected", enabled: true, variants: [{ id: "medium" }] },
        { providerID: "provider", id: "disabled", enabled: false, variants: [] },
      ],
    }),
  });
  expect(await discoverOpenCode("/isolated dir")).toEqual([
    { model: "provider/selected", efforts: ["medium"] },
  ]);
  expect(run.mock.calls).toEqual([
    [
      {
        tool: "opencode",
        args: ["api", "get", "/api/model?location%5Bdirectory%5D=%2Fisolated%20dir"],
        cwd: "/isolated dir",
        timeoutMs: 10000,
      },
    ],
  ]);
});

test("refuses unavailable, failed, timed out, and wrong-directory metadata", async () => {
  const run = spyOn(ToolInvocation, "run");
  run.mockResolvedValue({ status: "unavailable", tool: "opencode", detail: "missing" });
  expect(await discoverOpenCode("/isolated")).toMatchObject({ reason: "host_unavailable" });
  run.mockResolvedValue({ status: "no-answer", detail: "timeout" });
  expect(await discoverOpenCode("/isolated")).toMatchObject({ reason: "host_metadata_failed" });
  run.mockResolvedValue({
    status: "completed",
    exitCode: 1,
    stdout: "",
    stderr: "secret must not leak",
  });
  expect(await discoverOpenCode("/isolated")).toEqual({
    reason: "host_metadata_failed",
    detail: "OpenCode could not read its model catalog.",
  });
  run.mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: JSON.stringify({ location: { directory: "/different" }, data: [] }),
    stderr: "",
  });
  expect(await discoverOpenCode("/isolated")).toEqual({
    reason: "host_metadata_failed",
    detail: "OpenCode returned metadata for a different directory.",
  });
});

test("does not substitute a bundled Claude executable when the installed host is missing", async () => {
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: "" });
  expect(await discoverClaude("/isolated")).toEqual({
    reason: "host_unavailable",
    detail: "claude is not on PATH. Install Claude Code before selecting it.",
  });
});

test("reads installed Claude Code models without the session aliases and stops the host", async () => {
  const directory = await controlledClaude(
    "models",
    models([
      { value: "default" },
      { value: "opusplan" },
      {
        value: "alias",
        resolvedModel: "precise-model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      { value: "no-effort", supportsEffort: false, supportedEffortLevels: ["high"] },
      { value: "no-levels", supportsEffort: true },
    ]),
  );
  expect(await discoverClaude(`${directory}/work`)).toEqual([
    { model: "alias", resolvedModel: "precise-model", efforts: ["low", "high"] },
    { model: "no-effort", resolvedModel: undefined, efforts: [] },
    { model: "no-levels", resolvedModel: undefined, efforts: [] },
  ]);
  const run = z
    .object({ args: z.array(z.string()), cwd: z.string(), path: z.string() })
    .parse(await Bun.file(`${directory}/run.json`).json());
  expect(run.cwd).toBe(`${directory}/work`);
  expect(run.path).toBe(`${directory}/bin`);
  expect(run.args).toContain("--no-session-persistence");
  // The host gets end of input when the metadata read is done, so no host process stays open.
  for (
    let attempt = 0;
    attempt < 100 && !(await Bun.file(`${directory}/closed`).exists());
    attempt++
  )
    await Bun.sleep(20);
  expect(await Bun.file(`${directory}/closed`).exists()).toBe(true);
});

test("refuses an empty Claude Code model name as a defect", async () => {
  const directory = await controlledClaude("empty", models([{ value: "" }]));
  await expect(discoverClaude(`${directory}/work`)).rejects.toBeInstanceOf(z.ZodError);
});

test.each([
  "Claude Code process exited with code 7",
  "Claude Code process terminated by signal SIGKILL",
])("reports the SDK termination %p as failed metadata", async (error) => {
  const directory = await controlledClaude("terminated", refusal(error));
  expect(await discoverClaude(`${directory}/work`)).toEqual({
    reason: "host_metadata_failed",
    detail: "Claude Code metadata initialization failed. No selection was substituted.",
  });
});

test.each([
  "unexpected SDK failure",
  "wrapped: Claude Code process exited with code 7",
  "Claude Code process exited with code x",
  "Claude Code process terminated by signal SIGx",
])("preserves the unknown SDK failure %p for the host boundary", async (error) => {
  const directory = await controlledClaude("unknown", refusal(error));
  await expect(discoverClaude(`${directory}/work`)).rejects.toThrow(error);
});

test("stops a silent Claude Code host after ten seconds as failed metadata", async () => {
  const directory = await controlledClaude("silent", "");
  expect(await discoverClaude(`${directory}/work`)).toEqual({
    reason: "host_metadata_failed",
    detail: "Claude Code metadata initialization failed. No selection was substituted.",
  });
}, 25000);

test("leaves no timer that keeps the CLI process open after the metadata read", async () => {
  const directory = await controlledClaude("exit", models([{ value: "alias" }]));
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { discoverClaude } = await import(${JSON.stringify(modulePath)}); const started = Date.now(); const models = await discoverClaude(${JSON.stringify(`${directory}/work`)}); console.log(JSON.stringify({ started, models }));`,
    ],
    { env: Environment.child({ PATH: `${directory}/bin` }), stdout: "pipe", stderr: "pipe" },
  );
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).json().then((value) =>
      z
        .object({
          started: z.number(),
          models: z.array(z.looseObject({ model: z.string() })),
        })
        .parse(value),
    ),
  ]);
  expect(code).toBe(0);
  expect(output.models).toEqual([{ model: "alias", efforts: [] }]);
  // A ten-second metadata timer set after the start would hold the process open past this bound.
  // The bound counts from the read, not from the process start, so a loaded host passes too.
  expect(Date.now() - output.started).toBeLessThan(10000);
}, 20000);
