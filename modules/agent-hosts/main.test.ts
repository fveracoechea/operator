import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OkAsync, ErrAsync } from "unthrown";
import { AgentHosts } from "./main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";

const metadataFailure = {
  reason: "host_metadata_failed",
  detail: "The host did not return valid model and effort metadata. No selection was substituted.",
};

afterEach(() => {
  mock.restore();
});

test("preserves unexpected host-boundary defects instead of reclassifying them as metadata refusals", async () => {
  const cause = new TypeError("unexpected implementation defect");
  spyOn(ToolInvocation, "run").mockRejectedValue(cause);
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Defect",
    cause,
  });
});

test("classifies malformed metadata and known spawn failures without swallowing other Errors", async () => {
  const run = spyOn(ToolInvocation, "run");
  for (const code of ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR"]) {
    run.mockRejectedValue(Object.assign(new Error("spawn failed"), { code }));
    expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
      tag: "Err",
      error: metadataFailure,
    });
  }
  run.mockResolvedValue({ status: "completed", exitCode: 0, stdout: "{", stderr: "" });
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Err",
    error: metadataFailure,
  });
  run.mockResolvedValue({ status: "completed", exitCode: 0, stdout: "{}", stderr: "" });
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Err",
    error: metadataFailure,
  });
  run.mockRejectedValue(new Error("unexpected logic failure"));
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Defect",
  });
  run.mockRejectedValue(Object.assign(new Error("unknown system failure"), { code: "EBUSY" }));
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Defect",
  });
});

test("returns advertised models and keeps host refusals as errors", async () => {
  const run = spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      location: { directory: "/isolated" },
      data: [{ providerID: "p", id: "m", enabled: true, variants: [{ id: "high" }] }],
    }),
  });
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Ok",
    value: [{ model: "p/m", efforts: ["high"] }],
  });
  run.mockResolvedValue({ status: "unavailable", tool: "opencode", detail: "missing" });
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Err",
    error: { reason: "host_unavailable", detail: "missing" },
  });
});

test("reads Claude Code metadata only from the claude host", async () => {
  const run = spyOn(ToolInvocation, "run");
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: "" });
  expect(await AgentHosts.models({ host: "claude-code", cwd: "/isolated" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "host_unavailable",
      detail: "claude is not on PATH. Install Claude Code before selecting it.",
    },
  });
  expect(run).not.toHaveBeenCalled();
});

test("selects the full OpenCode TUI and keeps Claude's model and effort arguments", async () => {
  spyOn(AgentHosts, "models").mockReturnValue(
    OkAsync([{ model: "selected", efforts: ["medium"] }]),
  );
  for (const host of ["opencode", "claude-code"] as const) {
    const result = await AgentHosts.resolve({
      host,
      model: "selected",
      reasoningEffort: "medium",
      cwd: "/isolated",
    });
    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok")
      expect(result.value.command).toEqual(
        host === "opencode"
          ? { tool: "opencode", args: [] }
          : { tool: "claude", args: ["--model", "selected", "--effort", "medium"] },
      );
  }
});

test("resolves an advertised alias to its precise model without losing the requested selection", async () => {
  spyOn(AgentHosts, "models").mockReturnValue(
    OkAsync([{ model: "alias", resolvedModel: "precise", efforts: ["high"] }]),
  );
  const result = await AgentHosts.resolve({
    host: "claude-code",
    model: "alias",
    reasoningEffort: "high",
    cwd: "/isolated",
  });
  expect(result.tag).toBe("Ok");
  if (result.tag === "Ok")
    expect(result.value).toMatchObject({
      model: "precise",
      requestedModel: "alias",
      command: { args: ["--model", "precise", "--effort", "high"] },
    });
  expect(
    await AgentHosts.resolve({
      host: "claude-code",
      model: "precise",
      reasoningEffort: "high",
      cwd: "/isolated",
    }),
  ).toMatchObject({ tag: "Ok", value: { model: "precise", requestedModel: "precise" } });
});

test("refuses unknown models, unknown efforts, and unavailable metadata", async () => {
  const input = {
    host: "opencode" as const,
    model: "missing",
    reasoningEffort: "medium",
    cwd: "/isolated",
  };
  const mockModels = spyOn(AgentHosts, "models").mockReturnValue(
    OkAsync([{ model: "selected", efforts: ["high"] }]),
  );
  expect(await AgentHosts.resolve(input)).toMatchObject({
    tag: "Err",
    error: {
      reason: "unsupported_model",
      detail:
        "opencode does not advertise model missing. Select a model from operator host models.",
    },
  });
  expect(await AgentHosts.resolve({ ...input, model: "selected" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "unsupported_effort",
      detail: "opencode model selected does not advertise effort medium. Supported efforts: high.",
    },
  });
  mockModels.mockReturnValue(OkAsync([{ model: "selected", efforts: ["low", "high"] }]));
  expect(await AgentHosts.resolve({ ...input, model: "selected" })).toMatchObject({
    error: {
      detail:
        "opencode model selected does not advertise effort medium. Supported efforts: low, high.",
    },
  });
  mockModels.mockReturnValue(OkAsync([{ model: "selected", efforts: [] }]));
  expect(await AgentHosts.resolve({ ...input, model: "selected" })).toMatchObject({
    error: {
      detail:
        "opencode model selected does not advertise effort medium. Supported efforts: none advertised.",
    },
  });
  mockModels.mockReturnValue(ErrAsync({ reason: "host_unavailable", detail: "missing" } as const));
  expect(await AgentHosts.resolve(input)).toMatchObject({
    tag: "Err",
    error: { reason: "host_unavailable" },
  });
});

const launch = {
  host: "opencode" as const,
  model: "provider/model/with-slash",
  requestedModel: "provider/model/with-slash",
  reasoningEffort: "medium",
  command: { tool: "opencode", args: [] },
};
const start = { launch, cwd: "/worktree", name: "worker", paneId: "w1:p2" };
const session = {
  data: {
    id: "ses_worker",
    model: { providerID: "provider", id: "model/with-slash", variant: "medium" },
    location: { directory: "/worktree" },
  },
};

test("starts the full TUI on a session with the exact model, effort, and working directory", async () => {
  const run = spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: JSON.stringify(session),
    stderr: "",
  });
  const host = spyOn(Herdr, "startAgent").mockReturnValue(OkAsync(null));
  expect(await AgentHosts.start(start)).toMatchObject({ tag: "Ok" });
  expect(run).toHaveBeenCalledWith({
    tool: "opencode",
    cwd: "/worktree",
    timeoutMs: 30000,
    args: [
      "api",
      "post",
      "/api/session",
      "--data",
      JSON.stringify({
        model: { providerID: "provider", id: "model/with-slash", variant: "medium" },
        location: { directory: "/worktree" },
      }),
    ],
  });
  expect(host).toHaveBeenCalledTimes(1);
  expect(host).toHaveBeenCalledWith({
    name: "worker",
    kind: "opencode",
    paneId: "w1:p2",
    args: ["--session", "ses_worker"],
  });
});

test("never launches or substitutes after failed, uncertain, malformed, or mismatched session creation", async () => {
  const run = spyOn(ToolInvocation, "run");
  const host = spyOn(Herdr, "startAgent");
  for (const result of [
    { status: "unavailable" as const, tool: "opencode", detail: "missing" },
    { status: "no-answer" as const, detail: "timeout" },
    { status: "completed" as const, exitCode: 1, stdout: "", stderr: "refused" },
    {
      status: "completed" as const,
      exitCode: 1,
      stdout: JSON.stringify(session),
      stderr: "refused",
    },
    ...[
      "{",
      "{}",
      JSON.stringify({ data: { ...session.data, id: "" } }),
      JSON.stringify({
        data: { ...session.data, model: { ...session.data.model, variant: "high" } },
      }),
      JSON.stringify({ data: { ...session.data, model: { ...session.data.model, id: "other" } } }),
      JSON.stringify({
        data: { ...session.data, model: { ...session.data.model, providerID: "other" } },
      }),
      JSON.stringify({ data: { ...session.data, location: { directory: "/other" } } }),
    ].map((stdout) => ({ status: "completed" as const, exitCode: 0, stdout, stderr: "" })),
  ]) {
    run.mockResolvedValue(result);
    const failure =
      "OpenCode did not confirm a session with the selected model, effort, and directory. No agent was started. Session creation may have succeeded; inspect OpenCode before retrying.";
    const detail =
      result.status !== "completed"
        ? `${result.detail} ${failure}`
        : result.exitCode !== 0
          ? `OpenCode session creation exited 1. ${failure}`
          : failure;
    expect(await AgentHosts.start(start)).toMatchObject({
      tag: "Err",
      error: { reason: "host_session_failed", detail },
    });
  }
  expect(host).not.toHaveBeenCalled();
});

test("preserves session-creation defects and Herdr failures, and leaves Claude launches unchanged", async () => {
  const run = spyOn(ToolInvocation, "run").mockRejectedValue(new TypeError("defect"));
  expect(await AgentHosts.start(start)).toMatchObject({ tag: "Defect" });
  run.mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: JSON.stringify(session),
    stderr: "",
  });
  const error = { reason: "herdr_no_answer" as const, detail: "inspect before retry" };
  const host = spyOn(Herdr, "startAgent").mockReturnValue(ErrAsync(error));
  expect(await AgentHosts.start(start)).toMatchObject({ tag: "Err", error });
  run.mockClear();
  expect(
    await AgentHosts.start({
      ...start,
      launch: {
        ...launch,
        host: "claude-code",
        command: { tool: "claude", args: ["--model", "precise", "--effort", "high"] },
      },
    }),
  ).toMatchObject({ tag: "Err", error });
  expect(run).not.toHaveBeenCalled();
  expect(host).toHaveBeenLastCalledWith({
    name: "worker",
    kind: "claude",
    paneId: "w1:p2",
    args: ["--model", "precise", "--effort", "high"],
  });
});
