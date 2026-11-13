import { expect, test } from "bun:test";
import { isCodedError } from "./coded-error.ts";

test("accepts only errors with a string code", () => {
  expect(isCodedError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
  for (const cause of [
    new Error("plain"),
    Object.assign(new Error("numeric"), { code: 5 }),
    { code: "ENOENT" },
    "ENOENT",
    null,
  ]) {
    expect(isCodedError(cause)).toBe(false);
  }
});
