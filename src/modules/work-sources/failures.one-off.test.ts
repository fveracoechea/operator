import { expect, test } from "bun:test";
import { z } from "zod";
import { qualify } from "./failures.ts";

function defect(cause: Error) {
  return { defect: cause };
}

test.each([
  new SyntaxError("Unexpected token"),
  new z.ZodError([{ code: "custom", message: "Unknown kind.", path: ["kind"] }]),
])("one-off invalid input names dispatch recovery rather than plan registration: %s", (cause) => {
  expect(qualify(cause, defect, true)).toEqual({
    reason: "invalid_source_plan",
    detail: cause.message,
    next: {
      command: "operator dispatch --kind <kind> --brief <path|->",
      why: "Correct the kind, brief, or optional one-off flags before dispatching again.",
    },
    state: { inputValid: false },
  });
});

test("one-off file failures keep checked IO state and unexpected errors remain defects", () => {
  const missing = Object.assign(new Error("Brief missing"), { code: "ENOENT" });
  expect(qualify(missing, defect, true)).toEqual({
    reason: "source_io_failed",
    detail: "Error: Brief missing",
    next: {
      decider: "super-agent",
      question: "How should the source file IO failure be corrected before retrying?",
    },
    state: { code: "ENOENT" },
  });
  const unexpected = new TypeError("Broken reader");
  expect(qualify(unexpected, defect, true)).toEqual({ defect: unexpected });
});
