import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OkAsync, ErrAsync } from "unthrown";
import { AgentHosts } from "./main.ts";

afterEach(() => {
  mock.restore();
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
