import { expect, test } from "bun:test";
import { internalReview } from "./internal-review.ts";

test("internal review is on when no assignment, plan, or device value is set", () => {
  expect(internalReview({ assignment: undefined, plan: undefined, device: undefined })).toBe(true);
});

test.each([
  ["the assignment wins over the plan and the device", false, true, true, false],
  ["an assignment can turn it on for a plan that turned it off", true, false, false, true],
  ["the plan wins over the device", undefined, false, true, false],
  ["a plan can turn it on for a device that turned it off", undefined, true, false, true],
  [
    "the device value applies when the plan and assignment are unset",
    undefined,
    undefined,
    false,
    false,
  ],
])("%s", (_, assignment, plan, device, expected) => {
  expect(internalReview({ assignment, plan, device })).toBe(expected);
});
