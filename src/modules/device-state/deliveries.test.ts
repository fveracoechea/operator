import { expect, test } from "bun:test";
import { Ok, type Result } from "unthrown";
import { insertRow } from "./state-fixture.ts";
import {
  admitDelivery,
  readDelivery,
  recoverDelivery,
  changeDelivery,
  recordDeliveryValidation,
} from "./deliveries.ts";
import { changeObligation } from "./obligations.ts";
import { deliveryFixture as fixture } from "./delivery-fixture.ts";

const input = { launchId: "l", head: "h", selected: false, session: null };
const readiness = JSON.stringify({ head: "h", at: "then", note: null, dispositions: [] });
function ok<T, E>(result: Result<T, E>): T {
  expect(result.tag).toBe("Ok");
  // oxlint-disable-next-line unthrown/no-throw -- A failed fixture precondition must stop the test.
  if (result.tag !== "Ok") throw new Error("Expected successful fixture operation.");
  return result.value;
}

test("intent is durable, assignment-keyed, and recovery preserves its original actor", () => {
  using db = fixture();
  const admitted = ok(admitDelivery(db, input, true));
  // oxlint-disable-next-line unthrown/no-throw -- A direct fixture admission must return its intent.
  if (admitted === null) throw new Error("Missing direct intent.");
  expect(admitted).toMatchObject({
    launchId: "l",
    head: "h",
    requestUuid: null,
    endedAt: null,
    readiness,
  });
  expect(changeDelivery(db, admitted.id, { uuid: "request-7", suspend: true }).tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'interrupted'");
  insertRow(db, "launches", {
    id: "replacement",
    source_id: "s",
    assignment: "a",
    attempt: 2,
    branch: "task/a",
    state: "running",
  });
  expect(ok(readDelivery(db, "replacement"))).toMatchObject({
    launchId: "l",
    requestUuid: "request-7",
  });
  expect(ok(recoverDelivery(db, { ...input, launchId: "replacement" }, admitted.id))).toMatchObject(
    { launchId: "l", head: "h", readiness },
  );
  const claimed = db.serialize();
  expect(changeDelivery(db, admitted.id, { uuid: "different-request" })).toMatchObject({
    error: { reason: "pr_delivery_running" },
  });
  expect(db.serialize()).toEqual(claimed);
  expect(changeDelivery(db, admitted.id, { finish: true }).tag).toBe("Ok");
  expect(ok(readDelivery(db, "replacement"))).toBeNull();
});

test("holds and delivery intent exclude one another without acknowledging an ineffective hold", () => {
  using db = fixture();
  const delivery = ok(admitDelivery(db, input, true));
  // oxlint-disable-next-line unthrown/no-throw -- A direct fixture admission must return its intent.
  if (delivery === null) throw new Error("Missing direct intent.");
  const before = db.serialize();
  expect(
    changeObligation(db, { repository: "o/r", checkout: "/repo", sourceId: "s" }, "hold", () =>
      Ok({
        insert: {
          sourceId: "s",
          key: "hold",
          kind: "merge-hold",
          summary: "Wait.",
          reference: "other PR",
          openedAt: "now",
          state: "open",
          closedAt: null,
        },
      }),
    ),
  ).toMatchObject({ error: { reason: "pr_delivery_running" } });
  expect(db.serialize()).toEqual(before);
  changeDelivery(db, delivery.id, { finish: true });
  insertRow(db, "obligations", { source_id: "s", key: "hold", kind: "merge-hold", state: "open" });
  const held = db.serialize();
  expect(admitDelivery(db, input, true)).toMatchObject({ error: { reason: "pr_merge_held" } });
  expect(db.serialize()).toEqual(held);
});

test("the common owner and parked admission rejects unfinished stacks and stale correction evidence", () => {
  using db = fixture();
  insertRow(db, "stack_operations", {
    id: "stack",
    source_id: "s",
    assignment: "a",
    launch_id: "l",
    revision: 1,
    state: "uncertain",
    data: "{}",
  });
  const before = db.serialize();
  expect(admitDelivery(db, input, true)).toMatchObject({ error: { reason: "pr_stack_running" } });
  expect(db.serialize()).toEqual(before);
  db.exec(
    'UPDATE launches SET state = \'finished\'; UPDATE pull_requests SET parking = \'{"launchId":"l","head":"h","state":"parked"}\'',
  );
  expect(
    admitDelivery(db, { ...input, selected: true, session: "supervisor" }, true),
  ).toMatchObject({ error: { reason: "pr_stack_running" } });
  db.exec("UPDATE stack_operations SET state = 'complete'");
  expect(admitDelivery(db, { ...input, selected: true, session: "wrong" }, true)).toMatchObject({
    error: { reason: "source_supervised_elsewhere" },
  });
  expect(
    admitDelivery(db, { ...input, head: "corrected", selected: true, session: "supervisor" }, true),
  ).toMatchObject({ tag: "Err" });
});

test("known changed heads need evidence; migration-unknown readiness keeps accepted compatibility", () => {
  using db = fixture();
  expect(admitDelivery(db, { ...input, head: "new" }, true)).toMatchObject({
    error: { reason: "pr_validation_stale" },
  });
  db.query("UPDATE pull_requests SET readiness = ?").run(
    JSON.stringify({
      origin: "migration-0026",
      head: null,
      at: "then",
      note: null,
      dispositions: [],
    }),
  );
  expect(admitDelivery(db, { ...input, head: "new" }, true).tag).toBe("Ok");
});

test("validation follows readiness across replacement, but never a new ready provenance", () => {
  using db = fixture();
  const recorded = recordDeliveryValidation(db, {
    launchId: "l",
    head: "corrected",
    readiness,
    summary: "Scoped targeted-test receipt.",
  });
  expect(recorded.tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'interrupted'");
  insertRow(db, "launches", {
    id: "replacement",
    source_id: "s",
    assignment: "a",
    attempt: 2,
    branch: "task/a",
    state: "running",
  });
  expect(
    admitDelivery(db, { ...input, launchId: "replacement", head: "corrected" }, false).tag,
  ).toBe("Ok");
  db.query("UPDATE pull_requests SET readiness = ?").run(
    JSON.stringify({
      head: "h",
      at: "fresh-stack-review",
      note: null,
      dispositions: [],
    }),
  );
  const before = db.serialize();
  expect(
    admitDelivery(db, { ...input, launchId: "replacement", head: "corrected" }, true),
  ).toMatchObject({
    error: { reason: "pr_validation_stale" },
  });
  expect(db.serialize()).toEqual(before);
  expect(db.query("SELECT head, launch_id FROM delivery_validations").all()).toEqual([
    { head: "corrected", launch_id: "l" },
  ]);
});
