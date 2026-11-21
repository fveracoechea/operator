import { expect, test } from "bun:test";
import { deliveryFixture, deliveryInput } from "./delivery-fixture.ts";
import { admitDelivery } from "./deliveries.ts";
import { moveProject, removeProject } from "./projects.ts";

test("project move and removal cannot erase pending delivery even on a historical ended source", () => {
  using db = deliveryFixture();
  expect(admitDelivery(db, deliveryInput, true).tag).toBe("Ok");
  db.exec("UPDATE sources SET state = 'reset', ended_at = 'then'");
  const before = db.serialize();
  expect(moveProject(db, "o/r", "/elsewhere")).toMatchObject({
    error: { reason: "project_source_open" },
  });
  expect(removeProject(db, "o/r")).toMatchObject({ error: { reason: "project_source_open" } });
  expect(db.serialize()).toEqual(before);
});
