import { expect, test } from "bun:test";
import { initialize, open, read } from "../store.ts";
import { ReviewPrototype } from "./main.ts";
import { draft, facts, reviewing } from "./cases.fixture.ts";

test("the consuming command gets the computed post, state and guidance from its owner", () => {
  using db = open(":memory:", true);
  initialize(db, reviewing);
  const result = ReviewPrototype.run({ db, revision: 0, event: draft, facts, design: "table" });
  expect(result.effects[0]).toMatchObject({ type: "post-review", event: "APPROVE" });
  expect(result.blockers).toContain("outcome-unknown");
  expect(read(db).revision).toBe(1);
  expect(db.inTransaction).toBe(false);
  expect(
    ReviewPrototype.run({ db, revision: 0, event: draft, facts, design: "table" }),
  ).toMatchObject({ status: "refused", reason: "stale-revision", effects: [] });
});
