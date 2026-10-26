import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { fromThrowable, ErrAsync, OkAsync } from "unthrown";
import { AgentHosts } from "../agent-hosts/main.ts";
import { settingsSchema } from "./schema.ts";
import { validateSelections } from "./validation.ts";

afterEach(() => {
  mock.restore();
});

test("permits incomplete defaults without discovering a host but refuses an orphan model", async () => {
  const resolve = spyOn(AgentHosts, "resolve");
  expect(
    await validateSelections(
      settingsSchema.parse({ superAgent: { host: "opencode" } }),
      "/isolated",
    ),
  ).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  expect(
    await validateSelections(
      settingsSchema.parse({ workerAgent: { model: "orphan" } }),
      "/isolated",
    ),
  ).toMatchObject({ reason: "selection_incomplete" });
});

test("validates defaults and every extensible profile before an edit writes", async () => {
  const resolve = spyOn(AgentHosts, "resolve").mockImplementation((input) =>
    input.model === "bad"
      ? ErrAsync({ reason: "unsupported_model", detail: "bad" } as const)
      : OkAsync({ ...input, requestedModel: input.model, command: { tool: "opencode", args: [] } }),
  );
  const config = settingsSchema.parse({
    superAgent: { host: "opencode", model: "valid" },
    profiles: { investigation: { model: "bad" } },
  });
  expect(await validateSelections(config, "/isolated")).toMatchObject({
    reason: "unsupported_model",
  });
  expect(resolve.mock.calls.map(([input]) => input.reasoningEffort)).toEqual([
    "high",
    "medium",
    "medium",
  ]);
});

test("preserves unexpected defects for the settings command boundary", async () => {
  const cause = new Error("defect");
  const result = fromThrowable(
    (): never => {
      // oxlint-disable-next-line unthrown/no-throw -- This deliberate defect verifies propagation through the settings boundary.
      throw cause;
    },
    (_, defect) => defect(cause),
  )();
  spyOn(AgentHosts, "resolve").mockReturnValue(result.toAsync());
  await expect(
    validateSelections(
      settingsSchema.parse({ superAgent: { host: "opencode", model: "valid" } }),
      "/isolated",
    ),
  ).rejects.toBe(cause);
});
