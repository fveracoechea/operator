import { expect, test } from "bun:test";
import { timeoutSeconds } from "./timeout-seconds.ts";

test("accepts whole seconds beyond a foreground host timeout", () => {
  expect(timeoutSeconds("0")).toBe(0);
  expect(timeoutSeconds("540")).toBe(540);
  expect(timeoutSeconds("1000000")).toBe(1000000);
  for (const invalid of ["", "-1", "1.5", "Infinity", "1e6", " 540", "9007199254740992"])
    expect(timeoutSeconds(invalid)).toBeNull();
});
