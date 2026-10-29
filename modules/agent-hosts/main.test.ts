import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OkAsync, ErrAsync } from "unthrown";
import { AgentHosts } from "./main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Environment } from "../environment/main.ts";

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

test("constructs only model and effort command arguments for both hosts", async () => {
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
          ? { tool: "opencode", args: ["mini", "--model", "selected#medium"] }
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
