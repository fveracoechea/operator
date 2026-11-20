import { expect, test } from "bun:test";
import { reviewHandoffTarget } from "./handoff-target.ts";

test("draft review defaults legacy and null successors but retains every explicit target", () => {
  expect(reviewHandoffTarget(null)).toBe("review");
  expect(reviewHandoffTarget({ nextKind: null })).toBe("review");
  expect(reviewHandoffTarget({ nextKind: "custom-review" })).toBe("custom-review");
  expect(reviewHandoffTarget({ nextKind: "research" })).toBe("research");
});
