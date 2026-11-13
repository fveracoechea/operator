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
  emptyRequest,
  insertEffects,
  readReviewRequest,
  readReviewRequests,
  renewReviewLease,
  requestAssignmentReview,
} from "./review-requests.ts";
import { busy, reservedCopy } from "./state-fixture.ts";

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
    blockers: null,
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
    blockers: null,
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
  // An open request holds its project, so it ends and its cleanup finishes first.
  changeReviewRequest(db, target, () => Ok({ update: { state: "closed", cleanupState: "done" } }));
  expect(removeProject(db, "owner/one").tag).toBe("Ok");
  expect(db.query("SELECT COUNT(*) AS count FROM review_requests").get()).toEqual({ count: 0 });
});

test("an ended request with a pending or kept cleanup stays visible by its PR, but not by its id read", () => {
  for (const cleanupState of ["pending", "kept"]) {
    using db = fixture();
    changeReviewRequest(db, target, () => Ok({ insert: identity }));
    changeReviewRequest(db, target, () =>
      Ok({ update: { state: "closed", endedAt: "2026-10-27T00:00:00.000Z", cleanupState } }),
    );
    expect(readReviewRequest(db, target), cleanupState).toMatchObject({
      value: { request: null, ended: { id: "r1", cleanupState } },
    });
    expect(readReviewRequests(db), cleanupState).toMatchObject({
      tag: "Ok",
      value: [{ project: { repository: "owner/one", checkout: "/one" }, request: { id: "r1" } }],
    });
    // A read by id names its request and no ended one.
    expect(readReviewRequest(db, { ...target, id: "r1" })).toMatchObject({
      value: { request: { id: "r1" }, ended: null },
    });
  }
});

test("a change keeps a held lease unless it releases it, and returns the request it ended", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity, lease: "hold" as const }));
  expect(
    changeReviewRequest(db, target, () => Ok({ update: { state: "reviewing" } })),
  ).toMatchObject({ value: { request: { state: "reviewing", ownerPid: process.pid } } });
  db.exec("UPDATE review_requests SET lease_at = '2000-01-01T00:00:00.000Z'");
  expect(renewReviewLease(db, "r1").tag).toBe("Ok");
  expect(db.query("SELECT lease_at > '2001' AS fresh FROM review_requests").get()).toEqual({
    fresh: 1,
  });
  // The change ends the open request, and its result is that ended request.
  expect(changeReviewRequest(db, target, () => Ok({ update: { state: "closed" } }))).toMatchObject({
    value: { request: { id: "r1", state: "closed" } },
  });
  // A change on a PR with no request returns no request.
  expect(changeReviewRequest(db, target, () => Ok({}))).toMatchObject({
    tag: "Ok",
    value: { request: null, rounds: [], operations: [] },
  });
});

test("a change adds Slack effects only to a request with a Slack thread, once per key", () => {
  using db = fixture();
  const eyes = { key: "reaction:eyes", kind: "reaction", content: "eyes" };
  changeReviewRequest(db, target, () => Ok({ insert: identity, effects: [eyes] }));
  expect(db.query("SELECT * FROM slack_effects").all()).toEqual([]);
  changeReviewRequest(db, target, () =>
    Ok({ update: { slackChannel: "C1", slackTs: "100.000001" } }),
  );
  expect(db.query("SELECT * FROM slack_effects").all()).toEqual([]);
  changeReviewRequest(db, target, () => Ok({ effects: [eyes] }));
  changeReviewRequest(db, target, () => Ok({ effects: [{ ...eyes, content: "later" }] }));
  expect(
    db
      .query(
        "SELECT request_id, channel, thread_ts, key, kind, content, state, done_at, slack_ts, failure FROM slack_effects",
      )
      .all(),
  ).toEqual([
    {
      request_id: "r1",
      channel: "C1",
      thread_ts: "100.000001",
      key: "reaction:eyes",
      kind: "reaction",
      content: "eyes",
      state: "pending",
      done_at: null,
      slack_ts: null,
      failure: null,
    },
  ]);
});

test("Slack effects need both the channel and the thread of their request", () => {
  using db = fixture();
  changeReviewRequest(db, target, () => Ok({ insert: identity }));
  const eyes = { key: "reaction:eyes", kind: "reaction", content: "eyes" };
  function effects() {
    return db.query("SELECT key FROM slack_effects").all();
  }
  insertEffects(drizzle(db), { id: "r1", slackChannel: "C1", slackTs: null }, [eyes]);
  insertEffects(drizzle(db), { id: "r1", slackChannel: null, slackTs: "100.000001" }, [eyes]);
  expect(effects()).toEqual([]);
  insertEffects(drizzle(db), { id: "r1", slackChannel: "C1", slackTs: "100.000001" }, [eyes]);
  expect(effects()).toEqual([{ key: "reaction:eyes" }]);
});

test("a PR assignment gets one queued reviewer request unless its PR has an open request", () => {
  using db = fixture();
  const pr = {
    repository: "owner/one",
    number: 7,
    url: identity.url,
    sourceId: "s1",
    assignment: "change",
  };
  requestAssignmentReview(drizzle(db), pr);
  requestAssignmentReview(drizzle(db), pr);
  expect(
    db
      .query(
        "SELECT repository, number, url, origin, source_id, assignment, state, head_moves, owner_pid, slack_ts FROM review_requests",
      )
      .all(),
  ).toEqual([
    {
      repository: "owner/one",
      number: 7,
      url: identity.url,
      origin: "assignment",
      source_id: "s1",
      assignment: "change",
      state: "queued",
      head_moves: 0,
      owner_pid: null,
      slack_ts: null,
    },
  ]);
  expect(emptyRequest()).toMatchObject({ sourceId: null, headMoves: 0, slackTs: null });
  expect(Object.values(emptyRequest()).filter((value) => value !== null)).toEqual([0]);
  expect(Object.keys(emptyRequest())).toHaveLength(28);
});

test("reads need no writer reservation, and a change waits for it even when it refuses", () => {
  using db = fixture();
  using reserved = reservedCopy(db);
  expect(readReviewRequest(reserved.subject, target).tag).toBe("Ok");
  expect(readReviewRequests(reserved.subject).tag).toBe("Ok");
  expect(
    changeReviewRequest(reserved.subject, target, () => Err({ reason: "refused", detail: "No." })),
  ).toMatchObject(busy);
});
