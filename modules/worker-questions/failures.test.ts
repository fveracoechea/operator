import { expect, test } from "bun:test";
import { z } from "zod";
import { qualify } from "./failures.ts";

function defect(cause: Error) {
  return { defect: cause };
}

test("invalid input is a refusal that keeps the parser message", () => {
  expect(qualify(new SyntaxError("Unexpected token"), defect)).toEqual({
    reason: "invalid_question_input",
    detail: "Unexpected token Nothing changed.",
  });
  const invalid = new z.ZodError([{ code: "custom", message: "Bad.", path: ["key"] }]);
  expect(qualify(invalid, defect)).toEqual({
    reason: "invalid_question_input",
    detail: `${invalid.message} Nothing changed.`,
  });
});

test.each(["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EISDIR", "ELOOP"])(
  "a %s file system failure is a refusal",
  (code) => {
    const cause = Object.assign(new Error(`${code}: failed`), { code });
    expect(qualify(cause, defect)).toEqual({
      reason: "question_io_failed",
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

test("a message command names its own subject in a refusal", () => {
  expect(qualify(new SyntaxError("Unexpected token"), defect, "message")).toEqual({
    reason: "invalid_message_input",
    detail: "Unexpected token Nothing changed.",
  });
  const cause = Object.assign(new Error("ENOENT: failed"), { code: "ENOENT" });
  expect(qualify(cause, defect, "message")).toEqual({
    reason: "message_io_failed",
    detail: "Error: ENOENT: failed",
  });
});
