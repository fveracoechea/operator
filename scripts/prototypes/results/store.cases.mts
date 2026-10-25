import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initialize, read, transaction, write } from "./store.mts";
import { err, ok } from "./model.mts";
import { err as neverthrowErr } from "neverthrow";
import * as Result from "effect/Result";

test("the raw SQLite transaction commits returned failure values for every representation", () => {
  for (const failure of [
    err({ type: "test" }),
    neverthrowErr({ type: "test" }),
    Result.fail({ type: "test" }),
  ]) {
    using db = new Database(":memory:");
    initialize(db, "before");
    db.transaction(() => {
      write(db, "partial");
      return failure;
    }).immediate();
    expect(read(db)).toEqual({ revision: 1, state: "partial" });
  }
});

test("the state adapter rolls back a returned Err after a write and propagates defects", () => {
  using db = new Database(":memory:");
  initialize(db, "before");
  expect(
    transaction(db, () => {
      write(db, "partial");
      return err({ type: "test" });
    }),
  ).toEqual(err({ type: "test" }));
  expect(read(db)).toEqual({ revision: 0, state: "before" });
  expect(() =>
    transaction(db, () => {
      write(db, "partial");
      throw new TypeError("defect");
    }),
  ).toThrow("defect");
  expect(read(db)).toEqual({ revision: 0, state: "before" });
  expect(
    transaction(db, () => {
      write(db, "committed");
      return ok("done");
    }),
  ).toEqual(ok("done"));
  expect(read(db)).toEqual({ revision: 1, state: "committed" });
});
