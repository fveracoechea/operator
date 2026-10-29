import { expect, test } from "bun:test";
import { z } from "zod";
import { qualify } from "./failures.ts";

function defect(cause: Error) {
  return { defect: cause };
}

test("an invalid plan is a refusal that keeps the parser message", () => {
  expect(qualify(new SyntaxError("Unexpected token"), defect)).toEqual({
    reason: "invalid_source_plan",
    detail: "Unexpected token",
  });
  const invalid = new z.ZodError([{ code: "custom", message: "Bad.", path: ["trackerKey"] }]);
  expect(qualify(invalid, defect)).toEqual({
    reason: "invalid_source_plan",
    detail: invalid.message,
  });
});

test.each(["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "ENOTDIR"])(
  "a %s file system failure is a refusal",
  (code) => {
    const cause = Object.assign(new Error(`${code}: failed`), { code });
    expect(qualify(cause, defect)).toEqual({
      reason: "source_io_failed",
      detail: `Error: ${code}: failed`,
    });
  },
);

test("other errors stay defects", () => {
  const coded = Object.assign(new Error("full"), { code: "ENOSPC" });
  expect(qualify(coded, defect)).toEqual({ defect: coded });
  const plain = new TypeError("defect");
  expect(qualify(plain, defect)).toEqual({ defect: plain });
});
