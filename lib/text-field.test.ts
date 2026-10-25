import { expect, test } from "bun:test";
import { textField } from "./text-field.ts";

test("reads only string fields from untrusted objects", () => {
  expect(textField({ message: "failure" }, "message")).toBe("failure");
  expect(textField({ message: "" }, "message")).toBe("");
  for (const source of [null, undefined, "message", 1, {}, { message: 1 }]) {
    expect(textField(source, "message")).toBeNull();
  }
});
