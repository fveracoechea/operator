import { expect, test } from "bun:test";
import { WorkerDispatch } from "./main.ts";

test.each([
  { assignment: undefined, plan: undefined, device: undefined, expected: true },
  { assignment: false, plan: true, device: true, expected: false },
  { assignment: true, plan: false, device: false, expected: true },
  { assignment: undefined, plan: false, device: true, expected: false },
  { assignment: undefined, plan: true, device: false, expected: true },
  { assignment: undefined, plan: undefined, device: false, expected: false },
])(
  "shared review policy resolves assignment=$assignment, plan=$plan, device=$device",
  ({ expected, ...values }) => {
    expect(WorkerDispatch.resolveInternalReview(values)).toBe(expected);
  },
);
