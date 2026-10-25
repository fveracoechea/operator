import { expect, test } from "bun:test";
import { initialize, open, read, write } from "./store.ts";

test("state and revision commit together, exceptions roll both back", () => {
  using db = open(":memory:", true);
  initialize(db, { phase: "ready" });
  db.transaction(() => write(db, { phase: "running" })).immediate();
  expect(read(db)).toEqual({ revision: 1, state: { phase: "running" } });
  expect(() =>
    db
      .transaction(() => {
        write(db, { phase: "completed" });
        throw new Error("interrupted");
      })
      .immediate(),
  ).toThrow("interrupted");
  expect(read(db)).toEqual({ revision: 1, state: { phase: "running" } });
  expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(2);
});
