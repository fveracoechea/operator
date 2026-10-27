import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Err, Ok } from "unthrown";
import { migrationsFolder } from "./database.ts";
import { launchNames } from "./launches.ts";
import { registerProject, removeProject } from "./projects.ts";
import {
  changeReviewRequest,
  readReviewRequest,
  readReviewRequests,
  renewReviewLease,
} from "./review-requests.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  registerProject(db, { repository: "owner/one", checkout: "/one", registeredAt: "now" });
  return db;
}
const target = { repository: "owner/one", number: 7 };
const identity = {
  id: "r1",
  repository: "owner/one",
  number: 7,
  url: "https://github.com/owner/one/pull/7",
  origin: "slack",
  state: "queued",
};

test("a change reads the active request and its project inside the write", () => {
  using db = fixture();
  const seen: unknown[] = [];
  expect(
    changeReviewRequest(db, target, (current) => {
      seen.push(current);
      return Ok({ insert: identity, lease: "hold" as const });
    }),
  ).toMatchObject({
    tag: "Ok",
    value: {
      project: { repository: "owner/one", checkout: "/one" },
      request: { id: "r1", state: "queued", ownerPid: process.pid, launchState: null },
      rounds: [],
      ownerActive: true,
    },
  });
  expect(seen).toEqual([
    {
      project: { repository: "owner/one", checkout: "/one" },
      request: null,
      rounds: [],
      operations: [],
      ownerActive: false,
      ended: null,
    },
  ]);
  expect(readReviewRequest(db, { repository: "owner/two", number: 7 })).toMatchObject({
    value: { project: null, request: null },
  });
});

test("a refusal writes nothing, and a release clears the lease", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity, lease: "hold" as const }));
  expect(
    changeReviewRequest(db, target, () => Err({ reason: "refused", detail: "No." })),
  ).toMatchObject({ tag: "Err", error: { reason: "refused" } });
  expect(readReviewRequest(db, target)).toMatchObject({ value: { request: { state: "queued" } } });
  expect(renewReviewLease(db, "r1").tag).toBe("Ok");
  const released = changeReviewRequest(db, target, () =>
    Ok({ update: { state: "reviewing" }, lease: "release" as const }),
  );
  expect(released).toMatchObject({
    value: { request: { state: "reviewing", ownerPid: null, leaseAt: null }, ownerActive: false },
  });
  // An empty change writes nothing and still succeeds.
  expect(changeReviewRequest(db, target, () => Ok({})).tag).toBe("Ok");
});

test("rounds are inserted and then updated in place, and ended requests leave the open set", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity }));
  const round = {
    requestId: "r1",
    number: 1,
    trigger: "first",
    reviewedCommit: "abc",
    draft: "{}",
    event: "COMMENT",
    body: "body",
    marker: "m",
    outcome: "pending",
    reviewId: null,
    reviewUrl: null,
    postedAt: null,
    warning: null,
  };
  changeReviewRequest(db, target, () => Ok({ round }));
  changeReviewRequest(db, target, () =>
    Ok({ round: { ...round, outcome: "posted", reviewId: "R" }, update: { state: "approved" } }),
  );
  const rounds = db.query("SELECT outcome, review_id FROM review_rounds").all();
  expect(rounds).toEqual([{ outcome: "posted", review_id: "R" }]);
  // An approved request stays open, because a renewed request reopens it.
  expect(readReviewRequests(db)).toMatchObject({ value: [{ request: { id: "r1" } }] });
  expect(
    changeReviewRequest(db, target, () => Ok({ insert: { ...identity, id: "r2" } })).tag,
  ).not.toBe("Ok");
  changeReviewRequest(db, target, () => Ok({ update: { state: "closed", cleanupState: "done" } }));
  expect(readReviewRequests(db)).toMatchObject({ value: [] });
  expect(readReviewRequest(db, target)).toMatchObject({ value: { request: null, ended: null } });
  // A later request for the same PR is a new open request.
  changeReviewRequest(db, target, () => Ok({ insert: { ...identity, id: "r2" } }));
  expect(readReviewRequests(db)).toMatchObject({ value: [{ request: { id: "r2" } }] });
});

test("an ended request with an unfinished cleanup stays listed and readable by its PR", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity }));
  changeReviewRequest(db, target, () =>
    Ok({
      update: { state: "skipped", endedAt: "2026-10-27T00:00:00.000Z", cleanupState: "failed" },
    }),
  );
  expect(readReviewRequest(db, target)).toMatchObject({
    value: { request: null, ended: { id: "r1", cleanupState: "failed" } },
  });
  expect(readReviewRequests(db)).toMatchObject({ value: [{ request: { id: "r1" } }] });
  // The id selects the ended request for its cleanup.
  expect(
    changeReviewRequest(db, { ...target, id: "r1" }, () =>
      Ok({ update: { cleanupState: "done" } }),
    ),
  ).toMatchObject({ value: { request: { id: "r1", cleanupState: "done" } } });
  expect(readReviewRequests(db)).toMatchObject({ value: [] });
});

test("thread operations of the newest round are recorded and updated in place", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity }));
  const round = {
    requestId: "r1",
    number: 1,
    trigger: "first",
    reviewedCommit: "abc",
    draft: "{}",
    event: "COMMENT",
    body: "body",
    marker: "m",
    outcome: "pending",
    reviewId: null,
    reviewUrl: null,
    postedAt: null,
    warning: null,
  };
  const operation = {
    requestId: "r1",
    round: 1,
    threadId: "T",
    kind: "reply",
    body: "B",
    marker: "M",
    state: "pending",
    detail: null,
  };
  changeReviewRequest(db, target, () => Ok({ round, operations: [operation] }));
  expect(
    changeReviewRequest(db, target, () => Ok({ operations: [{ ...operation, state: "done" }] })),
  ).toMatchObject({ value: { operations: [{ threadId: "T", kind: "reply", state: "done" }] } });
});

test("one PR has at most one open request", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity }));
  expect(
    changeReviewRequest(db, target, () => Ok({ insert: { ...identity, id: "r2" } })).tag,
  ).not.toBe("Ok");
});

test("reviewer names join the launch name space, and project removal deletes review records", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity }));
  changeReviewRequest(db, target, () => Ok({ update: { name: "one-pr7-review" } }));
  expect(launchNames(db)).toMatchObject({ tag: "Ok", value: ["one-pr7-review"] });
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(db.query("SELECT COUNT(*) AS count FROM review_requests").get()).toEqual({ count: 0 });
});
