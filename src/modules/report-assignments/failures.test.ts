import { expect, test } from "bun:test";
import { z } from "zod";
import { qualify } from "./failures.ts";

function defect(cause: Error) {
  return { defect: cause };
}

test("invalid input is a refusal that keeps the parser message", () => {
  expect(qualify(new SyntaxError("Unexpected token"), defect)).toEqual({
    reason: "invalid_report_input",
    detail: "Unexpected token Nothing changed.",
  });
  const invalid = new z.ZodError([{ code: "custom", message: "Bad.", path: ["conclusion"] }]);
  expect(qualify(invalid, defect)).toEqual({
    reason: "invalid_report_input",
    detail: `${invalid.message} Nothing changed.`,
  });
});

test.each(["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR", "ELOOP"])(
  "a %s file system failure is a refusal",
  (code) => {
    const cause = Object.assign(new Error(`${code}: failed`), { code });
    expect(qualify(cause, defect)).toEqual({
      reason: "report_io_failed",
      detail: `Error: ${code}: failed`,
    });
  },
);

test("other errors stay defects", () => {
  const coded = Object.assign(new Error("exists"), { code: "EEXIST" });
  expect(qualify(coded, defect)).toEqual({ defect: coded });
  const plain = new TypeError("defect");
  expect(qualify(plain, defect)).toEqual({ defect: plain });
});
