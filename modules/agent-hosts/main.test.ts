import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OkAsync, ErrAsync } from "unthrown";
import { AgentHosts } from "./main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

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
  run.mockRejectedValue(Object.assign(new Error("missing executable"), { code: "ENOENT" }));
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Err",
    error: { reason: "host_metadata_failed" },
  });
  run.mockResolvedValue({ status: "completed", exitCode: 0, stdout: "{", stderr: "" });
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Err",
    error: { reason: "host_metadata_failed" },
  });
  run.mockRejectedValue(new Error("unexpected logic failure"));
  expect(await AgentHosts.models({ host: "opencode", cwd: "/isolated" })).toMatchObject({
    tag: "Defect",
  });
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
    error: { reason: "unsupported_model" },
  });
  expect(await AgentHosts.resolve({ ...input, model: "selected" })).toMatchObject({
    tag: "Err",
    error: { reason: "unsupported_effort" },
  });
  mockModels.mockReturnValue(ErrAsync({ reason: "host_unavailable", detail: "missing" } as const));
  expect(await AgentHosts.resolve(input)).toMatchObject({
    tag: "Err",
    error: { reason: "host_unavailable" },
  });
});
