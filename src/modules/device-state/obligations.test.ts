import { expect, test } from "bun:test";
import { Err, Ok } from "unthrown";
import { deleteSourceRecords, readSources } from "./sources.ts";
import { fixture } from "./conversation-fixture.ts";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { changeObligation, readObligations, type ObligationRow } from "./obligations.ts";
import { insertRow } from "./state-fixture.ts";

const target = { repository: "owner/one", checkout: "/one", sourceId: "s1" };

test("a merge hold refuses unfinished delivery even after its process exits", () => {
  using db = fixture();
  insertRow(db, "launches", { id: "delivery-launch", source_id: "s1", assignment: "read" });
  insertRow(db, "deliveries", {
    id: "d1",
    launch_id: "delivery-launch",
    head: "h1",
    selected: 1,
    started_at: "now",
  });
  insertRow(db, "deliveries", {
    id: "past",
    launch_id: "delivery-launch",
    head: "h1",
    selected: 1,
    started_at: "then",
    ended_at: "past-end",
  });
  expect<unknown>(
    changeObligation(db, target, "hold", () =>
      Ok({ insert: { ...obligation("hold"), kind: "merge-hold" } }),
    ),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "pr_delivery_running",
      detail:
        "A delivery is already in flight, so a new hold cannot stop it. Wait for its observed result before recording another hold. Nothing changed.",
      next: {
        decider: "super-agent",
        question: "How should the person's hold be reconciled with the delivery already in flight?",
      },
    },
  });
  expect(db.query("SELECT * FROM obligations").all()).toEqual([]);
  expect(
    changeObligation(db, target, "share", () => Ok({ insert: obligation("share") })),
  ).toMatchObject({
    tag: "Ok",
    value: {
      facts: { source: { id: "s1" }, obligation: null },
      change: { insert: { key: "share" } },
    },
  });
  db.exec("UPDATE deliveries SET ended_at = 'done'");
  expect(
    changeObligation(db, target, "hold", () =>
      Ok({ insert: { ...obligation("hold"), kind: "merge-hold" } }),
    ).tag,
  ).toBe("Ok");
});

function obligation(key: string): ObligationRow {
  return {
    sourceId: "s1",
    key,
    kind: "pr-share",
    summary: `Share ${key}.`,
    reference: null,
    openedAt: "now",
    state: "open",
    closedAt: null,
  };
}

test("the SuperAgent's selector reads and changes the obligations of a controlled source", () => {
  using db = fixture();
  expect(readObligations(db, target)).toMatchObject({
    tag: "Ok",
    value: { source: { id: "s1" }, obligations: [] },
  });
  expect(
    changeObligation(db, target, "share", (facts) => {
      expect(facts.obligation).toBeNull();
      return Ok({ insert: obligation("share") });
    }),
  ).toMatchObject({ tag: "Ok" });
  changeObligation(db, target, "rule", () => Ok({ insert: obligation("rule") }));
  expect(
    changeObligation(db, target, "share", (facts) => {
      expect(facts.obligation).toMatchObject({ key: "share", state: "open" });
      return Ok({ update: { state: "closed", closedAt: "later" } });
    }),
  ).toMatchObject({ tag: "Ok" });
  expect(readObligations(db, target)).toMatchObject({
    value: {
      obligations: [
        { key: "rule", state: "open" },
        { key: "share", state: "closed", closedAt: "later" },
      ],
    },
  });
  expect(readSources(db, "owner/one", "s1")).toMatchObject({
    value: [{ obligations: [{ key: "rule" }, { key: "share" }] }],
  });
});

test("a refused rule writes nothing, and another checkout or source changes nothing", () => {
  using db = fixture();
  expect(
    changeObligation(db, target, "share", () => Err({ reason: "refused", detail: "No." })),
  ).toMatchObject({ error: { reason: "refused" } });
  expect(
    changeObligation(db, { ...target, checkout: "/moved" }, "share", () =>
      Ok({ insert: obligation("share") }),
    ),
  ).toMatchObject({ error: { reason: "controller_mismatch" } });
  expect(readObligations(db, { ...target, sourceId: "missing" })).toMatchObject({
    error: { reason: "source_not_found" },
  });
  expect(db.query("SELECT key FROM obligations").all()).toEqual([]);
});

test("deleting a source deletes its obligations", () => {
  using db = fixture();
  changeObligation(db, target, "share", () => Ok({ insert: obligation("share") }));
  deleteSourceRecords(drizzle(db), ["s1"]);
  expect(db.query("SELECT key FROM obligations").all()).toEqual([]);
});
