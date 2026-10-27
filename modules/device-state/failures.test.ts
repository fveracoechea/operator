import { expect, test } from "bun:test";
import { errorCode, qualifyStateFailure } from "./failures.ts";

test("qualifies known SQLite and filesystem failures, but keeps defects separate", () => {
  for (const [code, reason] of [
    ["SQLITE_BUSY", "state_busy"],
    ["SQLITE_LOCKED", "state_busy"],
    ["SQLITE_CORRUPT", "state_corrupt"],
    ["SQLITE_NOTADB", "state_corrupt"],
    ["EACCES", "state_io_failed"],
    // A recursive removal that a permission stops reports a folder that is not empty.
    ["ENOTEMPTY", "state_io_failed"],
    ["EBUSY", "state_io_failed"],
    ["SQLITE_CANTOPEN", "state_io_failed"],
  ]) {
    expect(
      qualifyStateFailure(Object.assign(new Error(code), { code }), (cause) => ({ defect: cause })),
    ).toMatchObject({ reason });
  }
  const cause = new TypeError("implementation defect");
  expect(qualifyStateFailure(cause, (value) => ({ defect: value }))).toEqual({ defect: cause });
  expect(errorCode(null)).toBeUndefined();
  expect(errorCode({ code: "SQLITE_BUSY" })).toBeUndefined();
});
