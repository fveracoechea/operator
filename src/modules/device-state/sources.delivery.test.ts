import { expect, test } from "bun:test";
import { Ok } from "unthrown";
import { deliveryFixture, deliveryInput } from "./delivery-fixture.ts";
import { admitDelivery } from "./deliveries.ts";
import { endAssignments, pruneSource, resetSource } from "./sources.ts";

test("reset, abandon, and prune retain unresolved delivery and roll back byte-identically", () => {
  using db = deliveryFixture();
  expect(admitDelivery(db, deliveryInput, true).tag).toBe("Ok");
  const target = { repository: "o/r", checkout: "/repo", sourceId: "s" };
  const before = db.serialize();
  expect(resetSource(db, target, () => Ok({ abandon: ["a"] }))).toMatchObject({
    error: { reason: "pr_delivery_running" },
  });
  expect(endAssignments(db, target, () => Ok({ abandon: ["a"] }))).toMatchObject({
    error: { reason: "pr_delivery_running" },
  });
  expect(
    pruneSource(
      db,
      { stateRoot: "/synthetic", projects: "/synthetic/projects" },
      target,
      () => true,
    ),
  ).toMatchObject({ error: { reason: "pr_delivery_running" } });
  expect(db.serialize()).toEqual(before);
});
