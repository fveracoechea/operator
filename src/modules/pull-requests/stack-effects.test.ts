import { expect, test } from "bun:test";
import { stackEffect, unchangedIntegration } from "./stack-effects.ts";

test("uncertain stack writes cannot repeat after an original, foreign, or failed observation", () => {
  for (const observed of ["original", "other", "unknown"] as const)
    expect(stackEffect(true, observed)).toBe("blocked");
  expect(stackEffect(true, "requested")).toBe("verified");
  expect(stackEffect(false, "original")).toBe("write");
  expect(stackEffect(false, "other")).toBe("blocked");
  expect(stackEffect(false, "unknown")).toBe("blocked");
  expect(stackEffect(false, "requested")).toBe("verified");
});

test("a base-only integration change still needs fresh review", () => {
  expect(
    unchangedIntegration({ head: "same", candidate: "same", base: "old", targetBranch: "new" }),
  ).toBe(false);
  expect(
    unchangedIntegration({ head: "old", candidate: "new", base: "same", targetBranch: "same" }),
  ).toBe(false);
  expect(
    unchangedIntegration({ head: "same", candidate: "same", base: "same", targetBranch: "same" }),
  ).toBe(true);
});
