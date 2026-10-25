import { expect, test } from "bun:test";
import { initialize, open, read } from "../store.ts";
import { AssignmentPrototype } from "./main.ts";
import { facts, pr } from "./cases.fixture.ts";

test("the consuming command gets a committed plan and CLI guidance without private rules", () => {
  using db = open(":memory:", true);
  initialize(db, pr);
  const result = AssignmentPrototype.run({
    db,
    revision: 0,
    event: { type: "merge" },
    facts,
    design: "table",
  });
  expect(result.state.phase).toBe("pr-open");
  expect(result.effects.map((effect) => effect.type)).toEqual(["merge-pr"]);
  expect(result.blockers).toContain("outcome-unknown");
  expect(read(db).revision).toBe(1);
  expect(db.inTransaction).toBe(false);
  expect(
    AssignmentPrototype.run({ db, revision: 0, event: { type: "merge" }, facts, design: "table" }),
  ).toMatchObject({ status: "refused", reason: "stale-revision", effects: [] });
});
