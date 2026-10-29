import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Ok } from "unthrown";
import { migrationsFolder } from "./database.ts";
import { registerProject } from "./projects.ts";
import { changeReviewRequest } from "./review-requests.ts";
import { acknowledgeSlackEffect, ingestSlack, readSlack, startSlackWatch } from "./slack.ts";
import { busy, reservedCopy } from "./state-fixture.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder });
  registerProject(db, { repository: "owner/one", checkout: "/one", registeredAt: "now" });
  return db;
}
const eyes = { key: "reaction:eyes", kind: "reaction", content: "eyes" };
function candidate(number: number, repository = "owner/one") {
  return {
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    threadTs: `100.00000${number}`,
  };
}
function at(cursor: string) {
  return { cursor, latest: null, pending: null };
}
function ingest(db: Database, from: string, to: string, numbers: number[]) {
  return ingestSlack(db, {
    channel: "C1",
    from: at(from),
    to: { ...at(to), paging: false },
    candidates: numbers.map((number) => candidate(number)),
    start: [eyes],
  });
}
function rows(db: Database, query: string) {
  return db.query(query).all();
}

test("a read writes nothing, and the first watch records the start cursor once", () => {
  using db = fixture();
  expect(readSlack(db, "C1")).toMatchObject({ tag: "Ok", value: { watch: null, effects: [] } });
  expect(rows(db, "SELECT * FROM slack_watches")).toEqual([]);
  startSlackWatch(db, "C1", "10.000000");
  startSlackWatch(db, "C1", "99.000000");
  expect(readSlack(db, "C1")).toMatchObject({
    value: {
      watch: { channel: "C1", cursor: "10.000000", readAt: null, latest: null, pending: null },
    },
  });
});

test("a page keeps the cursor, records the paging bound, and makes the next read due at once", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  const paging = { cursor: "10.000000", latest: "15.000000", pending: "20.000000", paging: true };
  expect(
    ingestSlack(db, { channel: "C1", from: at("10.000000"), to: paging, candidates: [], start: [] })
      .tag,
  ).toBe("Ok");
  expect(rows(db, "SELECT cursor, latest, pending, read_at FROM slack_watches")).toEqual([
    { cursor: "10.000000", latest: "15.000000", pending: "20.000000", read_at: null },
  ]);
  // The next ingest must expect the paging state, not only the cursor.
  expect(
    ingestSlack(db, {
      channel: "C1",
      from: at("10.000000"),
      to: { ...at("20.000000"), paging: false },
      candidates: [],
      start: [],
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "slack_cursor_moved" } });
});

test("an ingest records eligible PRs with one start reaction and moves the cursor in one write", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  expect(
    ingestSlack(db, {
      channel: "C1",
      from: at("10.000000"),
      to: { ...at("20.000000"), paging: false },
      candidates: [candidate(7), candidate(3, "owner/two")],
      start: [eyes, eyes],
    }),
  ).toMatchObject({
    tag: "Ok",
    value: [
      { outcome: "recorded", candidate: { number: 7 } },
      { outcome: "unregistered", id: null },
    ],
  });
  expect(
    rows(db, "SELECT number, origin, state, slack_channel, slack_ts FROM review_requests"),
  ).toEqual([
    { number: 7, origin: "slack", state: "queued", slack_channel: "C1", slack_ts: "100.000007" },
  ]);
  expect(
    rows(db, "SELECT key, kind, content, channel, thread_ts, state FROM slack_effects"),
  ).toEqual([
    {
      key: "reaction:eyes",
      kind: "reaction",
      content: "eyes",
      channel: "C1",
      thread_ts: "100.000007",
      state: "pending",
    },
  ]);
  expect(readSlack(db, "C1")).toMatchObject({
    value: { watch: { cursor: "20.000000" }, effects: [{ url: candidate(7).url }] },
  });
  expect(rows(db, "SELECT read_at FROM slack_watches")).not.toEqual([{ read_at: null }]);
});

test("a cursor that another ingest moved refuses with no write", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  expect(ingest(db, "10.000000", "20.000000", [7]).tag).toBe("Ok");
  expect(ingest(db, "10.000000", "30.000000", [8])).toMatchObject({
    tag: "Err",
    error: { reason: "slack_cursor_moved" },
  });
  expect(rows(db, "SELECT number FROM review_requests")).toEqual([{ number: 7 }]);
  expect(rows(db, "SELECT cursor FROM slack_watches")).toEqual([{ cursor: "20.000000" }]);
  // No watch at all also refuses.
  expect(
    ingestSlack(db, {
      channel: "C2",
      from: at("1.0"),
      to: { ...at("2.0"), paging: false },
      candidates: [],
      start: [],
    }).tag,
  ).toBe("Err");
});

test("an open request keeps its thread, a manual request gets one, a skip stays, and a closed PR can return", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  for (const [id, number, state] of [
    ["manual", 7, "queued"],
    ["skipped", 8, "skipped"],
    ["closed", 9, "closed"],
  ] as const)
    changeReviewRequest(db, { repository: "owner/one", number }, () =>
      Ok({
        insert: {
          id,
          repository: "owner/one",
          number,
          url: candidate(number).url,
          origin: "slack",
          state,
        },
      }),
    );
  expect(ingest(db, "10.000000", "20.000000", [7, 8, 9])).toMatchObject({
    value: [{ outcome: "attached", id: "manual" }, { outcome: "skipped" }, { outcome: "recorded" }],
  });
  expect(ingest(db, "20.000000", "30.000000", [7])).toMatchObject({
    value: [{ outcome: "open", id: "manual" }],
  });
  expect(
    rows(db, "SELECT number, state, slack_ts FROM review_requests ORDER BY number, state"),
  ).toEqual([
    { number: 7, state: "queued", slack_ts: "100.000007" },
    { number: 8, state: "skipped", slack_ts: null },
    { number: 9, state: "closed", slack_ts: null },
    { number: 9, state: "queued", slack_ts: "100.000009" },
  ]);
  expect(rows(db, "SELECT thread_ts FROM slack_effects ORDER BY thread_ts")).toEqual([
    { thread_ts: "100.000007" },
    { thread_ts: "100.000009" },
  ]);
});

test("a request change records each effect key once, and only for a request with a Slack thread", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  ingest(db, "10.000000", "20.000000", [7]);
  const reply = { key: "reply:1", kind: "reply", content: "Approved · [review](u)" };
  for (let index = 0; index < 2; index++)
    changeReviewRequest(db, { repository: "owner/one", number: 7 }, () =>
      Ok({ effects: [reply, eyes] }),
    );
  changeReviewRequest(db, { repository: "owner/one", number: 5 }, () =>
    Ok({
      insert: {
        id: "r5",
        repository: "owner/one",
        number: 5,
        url: "u5",
        origin: "assignment",
        state: "queued",
      },
      effects: [reply],
    }),
  );
  expect(rows(db, "SELECT key FROM slack_effects ORDER BY key")).toEqual([
    { key: "reaction:eyes" },
    { key: "reply:1" },
  ]);
});

test("an acknowledgement marks an effect done once, and a refused send keeps it pending", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  ingest(db, "10.000000", "20.000000", [7]);
  const read = readSlack(db, "C1");
  const id = read.tag === "Ok" ? (read.value.effects[0]?.id ?? "") : "";
  const seen: string[] = [];
  expect(
    acknowledgeSlackEffect(db, id, (effect) => {
      seen.push(`${effect.kind} ${effect.content}`);
      return { kind: "failed", detail: "invalid_name" };
    }),
  ).toMatchObject({
    value: { changed: true, effect: { state: "pending", failure: "invalid_name" } },
  });
  // The decision sees the recorded effect, so the result can prove that exact effect.
  expect(seen).toEqual(["reaction eyes"]);
  expect(
    acknowledgeSlackEffect(db, id, () => ({ kind: "done", slackTs: "5.000001" })),
  ).toMatchObject({
    value: { changed: true, effect: { state: "done", slackTs: "5.000001", failure: null } },
  });
  expect(acknowledgeSlackEffect(db, id, () => ({ kind: "failed", detail: "late" }))).toMatchObject({
    value: { changed: false, effect: { state: "done", failure: null } },
  });
  expect(readSlack(db, "C1")).toMatchObject({ value: { effects: [] } });
  expect(
    acknowledgeSlackEffect(db, "missing", () => ({ kind: "done", slackTs: null })),
  ).toMatchObject({
    tag: "Err",
    error: { reason: "slack_effect_missing" },
  });
});

test("an approved request and an assignment review take no Slack thread", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  for (const [id, number, state, origin] of [
    ["approved", 7, "approved", "slack"],
    ["assigned", 8, "queued", "assignment"],
  ] as const)
    changeReviewRequest(db, { repository: "owner/one", number }, () =>
      Ok({
        insert: { id, repository: "owner/one", number, url: candidate(number).url, origin, state },
      }),
    );
  expect(ingest(db, "10.000000", "20.000000", [7, 8])).toMatchObject({
    value: [
      { outcome: "approved", id: "approved" },
      { outcome: "assignment", id: "assigned" },
    ],
  });
  expect(rows(db, "SELECT slack_ts FROM review_requests")).toEqual([
    { slack_ts: null },
    { slack_ts: null },
  ]);
  expect(rows(db, "SELECT * FROM slack_effects")).toEqual([]);
});

test("a cursor refusal compares the paging bounds too and names the channel", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  const moved = {
    tag: "Err",
    error: {
      reason: "slack_cursor_moved",
      detail:
        "Another ingest moved the cursor of C1. Run operator review wait for the next read. Nothing was recorded.",
    },
  };
  for (const from of [
    { cursor: "10.000000", latest: "15.000000", pending: null },
    { cursor: "10.000000", latest: null, pending: "20.000000" },
  ])
    expect(
      ingestSlack(db, {
        channel: "C1",
        from,
        to: { ...at("30.000000"), paging: false },
        candidates: [candidate(7)],
        start: [eyes],
      }),
      JSON.stringify(from),
    ).toMatchObject(moved);
  expect(rows(db, "SELECT * FROM review_requests")).toEqual([]);
  expect(rows(db, "SELECT cursor FROM slack_watches")).toEqual([{ cursor: "10.000000" }]);
  expect(
    acknowledgeSlackEffect(db, "missing", () => ({ kind: "done", slackTs: null })),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "slack_effect_missing",
      detail:
        "No Slack effect has the id missing. Read operator review wait for the pending effects.",
    },
  });
});

test("a read needs no writer reservation, and an ingest or an acknowledgement waits for it", () => {
  using db = fixture();
  startSlackWatch(db, "C1", "10.000000");
  using reserved = reservedCopy(db);
  expect(readSlack(reserved.subject, "C1").tag).toBe("Ok");
  expect(
    ingestSlack(reserved.subject, {
      channel: "C1",
      from: at("1.000000"),
      to: { ...at("2.000000"), paging: false },
      candidates: [],
      start: [],
    }),
  ).toMatchObject(busy);
  expect(
    acknowledgeSlackEffect(reserved.subject, "missing", () => ({ kind: "done", slackTs: null })),
  ).toMatchObject(busy);
});
