import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import {
  parkPullRequest,
  completeParking,
  claimParkedRead,
  finishParkedRead,
  resumeParkedPullRequest,
  prParkingSchema,
  recordPullRequestQueue,
  refusePullRequestQueue,
  recordPullRequestQueueRefusal,
  activateParking,
} from "./pr-parking.ts";

afterEach(() => mock.restore());

test("parking retains legacy facts and accepts unknown heads only with explicit migration origin", () => {
  const park = {
    launchId: "old",
    head: "known",
    at: "then",
    note: "/notes/park.md",
    state: "parked" as const,
    events: [],
  };
  expect(prParkingSchema.parse(park)).toEqual({ ...park, parentSeen: false });
  expect(prParkingSchema.safeParse({ ...park, head: null }).success).toBe(false);
  expect(prParkingSchema.parse({ ...park, head: null, origin: "migration-0026" })).toEqual({
    ...park,
    parentSeen: false,
    head: null,
    origin: "migration-0026",
  });
});

function fixture() {
  const db = new Database(":memory:");
  migrate(drizzle(db), { migrationsFolder });
  insertRow(db, "sources", { id: "s", repository: "owner/repo", state: "open" });
  insertRow(db, "assignments", { source_id: "s", key: "a", completion: "pr", state: "pr-open" });
  insertRow(db, "launches", {
    id: "l",
    source_id: "s",
    assignment: "a",
    attempt: 1,
    state: "running",
    branch: "task/a",
    kind: JSON.stringify(WorkerKinds.resolve("pr-feedback")),
  });
  insertRow(db, "pull_requests", {
    source_id: "s",
    assignment: "a",
    repository: "owner/repo",
    number: 7,
    branch: "task/a",
    progress: '{"seen":[],"failures":[],"eligibleHead":null}',
    readiness: '{"head":"h","at":"now","note":null,"dispositions":[]}',
    wait_state: "waiting",
  });
  return db;
}

test("queue disposition belongs to the PR receipt and survives parking again", () => {
  using db = fixture();
  expect(recordPullRequestQueue(db, "l", "h")).toMatchObject({ tag: "Ok" });
  expect(db.query("SELECT COUNT(*) AS count FROM kind_handoffs").get()).toEqual({ count: 0 });
  expect(parkPullRequest(db, "l", { head: "h", note: "/park.md" })).toMatchObject({
    tag: "Ok",
    value: { queueHead: "h", state: "parking" },
  });
  db.exec("UPDATE launches SET state = 'finished'");
  const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
  expect(completeParking(db, target).tag).toBe("Ok");
  expect(recordPullRequestQueue(db, "l", "h").tag).toBe("Ok");
  const before = db.serialize();
  expect(recordPullRequestQueue(db, "l", "different").tag).toBe("Err");
  expect(db.serialize()).toEqual(before);
  const claim = claimParkedRead(db, Date.now()).getOr(null);
  expect(claim?.rows[0]?.parking).toMatchObject({ queueHead: "h", head: "h", state: "parked" });
});

test("a proven refusal releases only its exact queue attempt, never a later attempt at the same head", () => {
  using db = fixture();
  const first = recordPullRequestQueue(db, "l", "h").getOr(null);
  expect(first).not.toBeNull();
  if (first === null) return expect.unreachable("The first admission must own its attempt.");
  expect(recordPullRequestQueue(db, "l", "h").getOr("unexpected")).toBeNull();
  expect(recordPullRequestQueueRefusal(db, "l", "h", first, "Typed refusal.").tag).toBe("Ok");
  expect(
    refusePullRequestQueue(db, "l", "h", first, { head: "h", state: "OPEN", entry: null }).getOr(
      false,
    ),
  ).toBe(true);
  const second = recordPullRequestQueue(db, "l", "h").getOr(null);
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  const before = db.serialize();
  expect(recordPullRequestQueueRefusal(db, "l", "h", first, "Stale proof.").tag).toBe("Err");
  expect(
    refusePullRequestQueue(db, "l", "h", first, { head: "h", state: "OPEN", entry: null }).tag,
  ).toBe("Err");
  expect(
    refusePullRequestQueue(db, "l", "other", second ?? "", {
      head: "h",
      state: "OPEN",
      entry: null,
    }).tag,
  ).toBe("Err");
  expect(db.serialize()).toEqual(before);
  expect(parkPullRequest(db, "l", { head: "h", note: null })).toMatchObject({
    tag: "Ok",
    value: { queueHead: "h", queueAttempt: second },
  });
});

test("queue refusal proof survives parking, but accepted membership permanently retains that attempt", () => {
  using db = fixture();
  const attempt = recordPullRequestQueue(db, "l", "h").getOr(null);
  if (attempt === null) return expect.unreachable("The new attempt must be owned.");
  const open = { head: "h", state: "OPEN", entry: null };
  const unknown = db.serialize();
  expect(refusePullRequestQueue(db, "l", "h", attempt, open).getOr(true)).toBe(false);
  expect(db.serialize()).toEqual(unknown);
  expect(recordPullRequestQueueRefusal(db, "l", "h", attempt, "Typed refusal.").tag).toBe("Ok");
  for (const observed of [
    { ...open, head: "changed" },
    { ...open, state: "CLOSED" },
    { ...open, state: "MERGED" },
  ]) {
    const before = db.serialize();
    expect(refusePullRequestQueue(db, "l", "h", attempt, observed).getOr(true)).toBe(false);
    expect(db.serialize()).toEqual(before);
  }
  expect(parkPullRequest(db, "l", { head: "h", note: null })).toMatchObject({
    tag: "Ok",
    value: { queueRefusal: { attempt, head: "h", detail: "Typed refusal." } },
  });
  expect(refusePullRequestQueue(db, "l", "h", attempt, { ...open, entry: "Q7" }).getOr(true)).toBe(
    false,
  );
  expect(recordPullRequestQueueRefusal(db, "l", "h", attempt, "Stale refusal.").tag).toBe("Ok");
  const accepted = db.serialize();
  expect(refusePullRequestQueue(db, "l", "h", attempt, open).getOr(true)).toBe(false);
  expect(db.serialize()).toEqual(accepted);
});

test.each([
  "DELETE FROM pull_requests",
  "UPDATE assignments SET state = 'running'",
  "UPDATE pull_requests SET branch = 'foreign'",
  "UPDATE launches SET state = 'finished'",
])("queue disposition refuses a changed owner without a receipt write: %s", (change) => {
  using db = fixture();
  db.exec(change);
  const before = db.serialize();
  expect(recordPullRequestQueue(db, "l", "h").tag).toBe("Err");
  expect(db.serialize()).toEqual(before);
});

test.each(["park", "complete", "resume", "activate"] as const)(
  "corrupt readiness refuses the %s transaction without authorizing a handoff",
  (operation) => {
    using db = fixture();
    const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
    if (operation !== "park") {
      expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
      db.exec("UPDATE launches SET state = 'finished'");
    }
    if (operation === "resume" || operation === "activate") {
      expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
      db.exec(
        `UPDATE pull_requests SET parking = json_set(parking, '$.events', json('["feedback"]'))`,
      );
    }
    if (operation === "activate") expect(resumeParkedPullRequest(db, target).tag).toBe("Ok");
    db.exec("UPDATE pull_requests SET readiness = '{}'");
    const before = db.serialize();
    const result =
      operation === "park"
        ? parkPullRequest(db, "l", { head: "h", note: null })
        : operation === "complete"
          ? completeParking(db, target)
          : operation === "resume"
            ? resumeParkedPullRequest(db, target)
            : activateParking(drizzle(db), target, { id: "l" });
    expect(result).toMatchObject({ tag: "Err", error: { reason: "state_corrupt" } });
    expect(db.serialize()).toEqual(before);
  },
);

test.each(["{", "{}", "", "null"])(
  "a parked claim refuses corrupt readiness %j and rolls back its lease",
  (readiness) => {
    using db = fixture();
    const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
    expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
    db.exec("UPDATE launches SET state = 'finished'");
    expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
    db.query("UPDATE pull_requests SET readiness = ?").run(readiness);
    const before = db.serialize();
    expect(claimParkedRead(db, Date.now())).toMatchObject({
      tag: "Err",
      error: { reason: "state_corrupt", state: { readinessValid: false } },
    });
    expect(db.serialize()).toEqual(before);
  },
);

test.each([null, { head: "legacy-ready-head", at: "then", note: null, dispositions: [] }])(
  "a parked claim returns decoded readiness %j without adding a historical rule",
  (readiness) => {
    using db = fixture();
    const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
    expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
    db.exec("UPDATE launches SET state = 'finished'");
    expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
    db.query("UPDATE pull_requests SET readiness = ?").run(
      readiness === null ? null : JSON.stringify({ ...readiness, extra: "historical metadata" }),
    );
    expect(claimParkedRead(db, Date.now())).toMatchObject({
      tag: "Ok",
      value: { rows: [{ readiness }] },
    });
  },
);

test("a parked claim preserves the original unexpected decoder fault and rolls back its lease", () => {
  using db = fixture();
  const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
  expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'finished'");
  expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
  const text = '{"head":"h","at":"now","note":null,"dispositions":[]}';
  const before = db.serialize();
  const cause = new TypeError("original parked readiness fault");
  const parse = JSON.parse;
  spyOn(JSON, "parse").mockImplementation((value, reviver) => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a decoder fault to verify the original Defect survives the storage boundary.
    if (value === text) throw cause;
    const decoded: unknown = parse(value, reviver);
    return decoded;
  });
  const result = claimParkedRead(db, Date.now());
  expect(result.tag).toBe("Defect");
  if (result.tag === "Defect") expect(result.cause).toBe(cause);
  expect(db.serialize()).toEqual(before);
});

test("parking retains the pushed head and park note with the recorded outgoing handoff", () => {
  using db = fixture();
  expect(parkPullRequest(db, "l", { head: "h", note: "/device/park.md" })).toMatchObject({
    tag: "Ok",
  });
  expect(db.query("SELECT state FROM assignments").get()).toEqual({ state: "pr-open" });
  expect(
    db.query("SELECT outgoing_launch_id, next_kind, handoff_state FROM kind_handoffs").get(),
  ).toEqual({ outgoing_launch_id: "l", next_kind: "pr-feedback", handoff_state: "pending" });
  const row = db.query<{ parking: string }, []>("SELECT parking FROM pull_requests").get();
  expect(JSON.parse(row?.parking ?? "null")).toMatchObject({
    launchId: "l",
    head: "h",
    note: "/device/park.md",
    state: "parking",
    events: [],
  });
});

test("one recorded batch schedule and cursor commit survives quiet and repeated waits", () => {
  using db = fixture();
  const now = Date.now();
  expect(claimParkedRead(db, now)).toMatchObject({
    tag: "Ok",
    value: { at: new Date(now).toISOString() },
  });
  expect(claimParkedRead(db, now + 1)).toMatchObject({ tag: "Ok", value: null });
  expect(finishParkedRead(db, new Date(now).toISOString(), [])).toMatchObject({ tag: "Ok" });
  expect(claimParkedRead(db, now + 899999)).toMatchObject({ tag: "Ok", value: null });
  expect(claimParkedRead(db, now + 900000)).toMatchObject({
    tag: "Ok",
    value: { at: new Date(now + 900000).toISOString() },
  });
});

test("a quiet parked PR refuses resume without a recorded event or any handoff write", () => {
  using db = fixture();
  const before = db.serialize();
  expect(
    resumeParkedPullRequest(db, { repository: "owner/repo", sourceId: "s", assignment: "a" }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_resume_refused" } });
  expect(db.serialize()).toEqual(before);
});

test("a committed waking event survives resume and stale batch commits cannot erase it", () => {
  using db = fixture();
  const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
  const parked = parkPullRequest(db, "l", { head: "h", note: null });
  expect(parked.tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'finished'");
  const beforeWrongRepository = db.serialize();
  expect(completeParking(db, { ...target, repository: "foreign/repo" })).toMatchObject({
    tag: "Err",
    error: { reason: "pr_resume_refused" },
  });
  expect(db.serialize()).toEqual(beforeWrongRepository);
  expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
  const claimed = claimParkedRead(db, Date.now());
  expect(claimed).toMatchObject({ tag: "Ok", value: { rows: [{ assignment: "a" }] } });
  if (claimed.tag !== "Ok" || claimed.value === null) return;
  const row = claimed.value.rows[0];
  expect(row).toBeDefined();
  if (row === undefined) return;
  const update = {
    ...target,
    previous: row.parkingRaw,
    progress: '{"seen":["C1"],"failures":[],"eligibleHead":null}',
    parking: { ...row.parking, events: ['{"kind":"feedback","id":"C1"}'] },
  };
  expect(finishParkedRead(db, claimed.value.at, [update])).toMatchObject({
    tag: "Ok",
    value: true,
  });
  expect(resumeParkedPullRequest(db, target)).toMatchObject({ tag: "Ok" });
  expect(db.query("SELECT handoff_state, outgoing_launch_id FROM kind_handoffs").get()).toEqual({
    handoff_state: "pending",
    outgoing_launch_id: "l",
  });
  expect(
    finishParkedRead(db, claimed.value.at, [{ ...update, parking: row.parking }]),
  ).toMatchObject({ tag: "Ok", value: false });
  expect(
    JSON.parse(
      db.query<{ parking: string }, []>("SELECT parking FROM pull_requests").get()?.parking ??
        "null",
    ),
  ).toMatchObject({ state: "resuming", events: ['{"kind":"feedback","id":"C1"}'] });
  const before = db.serialize();
  expect(resumeParkedPullRequest(db, target)).toMatchObject({ tag: "Err" });
  expect(db.serialize()).toEqual(before);
});

test("a raced batch receipt refuses the whole cursor commit without acknowledging the read", () => {
  using db = fixture();
  const target = { repository: "owner/repo", sourceId: "s", assignment: "a" };
  expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'finished'");
  expect(completeParking(db, target)).toMatchObject({ tag: "Ok", value: true });
  const claim = claimParkedRead(db, Date.now()).getOr(null);
  const row = claim?.rows[0] ?? expect.unreachable("Missing batch row");
  db.query("UPDATE pull_requests SET parking = ?").run(
    JSON.stringify({ ...row.parking, events: ["racing event"] }),
  );
  expect(
    finishParkedRead(db, claim?.at ?? "", [
      {
        ...target,
        previous: row.parkingRaw,
        progress: "new cursor",
        parking: row.parking,
      },
    ]),
  ).toMatchObject({ tag: "Ok", value: false });
  expect(db.query("SELECT last_read_at FROM parked_pr_reads").get()).toEqual({
    last_read_at: null,
  });
  expect(db.query("SELECT progress FROM pull_requests").get()).toEqual({
    progress: '{"seen":[],"failures":[],"eligibleHead":null}',
  });
});

test.each([false, true])(
  "a noncanonical parking receipt commits only while its exact raw bytes are unchanged: race %s",
  (race) => {
    using db = fixture();
    const raw =
      '{\n  "state": "parked", "head": "h", "launchId": "l", "at": "then",\n  "events": [], "note": null\n}';
    db.query("UPDATE pull_requests SET parking = ?").run(raw);
    const claim = claimParkedRead(db, Date.now()).getOr(null);
    const row = claim?.rows[0] ?? expect.unreachable("Missing batch row");
    expect(row.parkingRaw).toBe(raw);
    expect(row.parking).toEqual({
      launchId: "l",
      head: "h",
      at: "then",
      note: null,
      state: "parked",
      events: [],
      parentSeen: false,
    });
    const racingRaw = `${raw}\n`;
    if (race) db.query("UPDATE pull_requests SET parking = ?").run(racingRaw);
    const before = db.serialize();
    const progress = '{"seen":["C1"],"failures":[],"eligibleHead":null}';
    const parking = { ...row.parking, events: ['{"kind":"feedback","id":"C1"}'] };
    expect(
      finishParkedRead(db, claim?.at ?? "", [
        { sourceId: "s", assignment: "a", previous: row.parkingRaw, progress, parking },
      ]),
    ).toMatchObject({ tag: "Ok", value: !race });
    if (race) {
      expect(db.serialize()).toEqual(before);
      expect(db.query("SELECT parking, progress FROM pull_requests").get()).toEqual({
        parking: racingRaw,
        progress: '{"seen":[],"failures":[],"eligibleHead":null}',
      });
      expect(db.query("SELECT last_read_at FROM parked_pr_reads").get()).toEqual({
        last_read_at: null,
      });
    } else {
      expect(db.query("SELECT parking, progress FROM pull_requests").get()).toEqual({
        parking: JSON.stringify(parking),
        progress,
      });
      expect(
        db.query("SELECT last_read_at, owner_pid, lease_at FROM parked_pr_reads").get(),
      ).toEqual({ last_read_at: claim?.at, owner_pid: null, lease_at: null });
    }
  },
);

test("migration resume preserves historical launch facts and does not create a kind handoff", () => {
  using db = fixture();
  db.exec(
    "UPDATE assignments SET kind = 'pr-feedback'; UPDATE launches SET state = 'interrupted', kind = NULL",
  );
  const parking = {
    origin: "migration-0026",
    launchId: "l",
    head: null,
    at: "then",
    note: null,
    state: "parked",
    events: ['{"kind":"feedback","id":"C1"}'],
    parentSeen: false,
  };
  db.query("UPDATE pull_requests SET parking = ?").run(JSON.stringify(parking));
  const launches = db.query("SELECT * FROM launches").all();
  expect(
    resumeParkedPullRequest(db, { repository: "owner/repo", sourceId: "s", assignment: "a" }),
  ).toMatchObject({ tag: "Ok" });
  expect(
    JSON.parse(
      db.query<{ parking: string }, []>("SELECT parking FROM pull_requests").get()?.parking ??
        "null",
    ),
  ).toEqual({ ...parking, state: "resuming" });
  expect(db.query("SELECT * FROM launches").all()).toEqual(launches);
  expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual([]);
});

test.each(["migration", "ordinary"] as const)(
  "a kind fill refuses before any %s parking-resume write",
  (origin) => {
    using db = fixture();
    db.exec("UPDATE assignments SET kind = 'pr-feedback'; UPDATE launches SET state = 'finished'");
    const migrated =
      origin === "migration" ? { origin: "migration-0026", head: null } : { head: "h" };
    const parking = JSON.stringify({
      ...migrated,
      launchId: "l",
      at: "then",
      note: null,
      state: "parked",
      events: ['{"kind":"feedback"}'],
    });
    db.query("UPDATE pull_requests SET parking = ?").run(parking);
    const before = db.serialize();
    expect(
      resumeParkedPullRequest(
        db,
        { repository: "owner/repo", sourceId: "s", assignment: "a" },
        "implementation",
      ),
    ).toMatchObject({
      tag: "Err",
      error: {
        reason: "assignment_kind_set",
        detail: "The assignment already has a kind. Nothing changed.",
        next: { command: "operator next", why: "Use the recorded assignment kind." },
        state: { kind: "pr-feedback" },
      },
    });
    expect(db.serialize()).toEqual(before);
    expect(db.query("SELECT parking FROM pull_requests").get()).toEqual({ parking });
    expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual([]);
  },
);

test.each([
  [null, true],
  ["own", true],
  ["foreign", true],
  ["foreign", false],
] as const)(
  "parking resume rechecks source ownership held by %s with caller supplied %s",
  (session, callerSupplied) => {
    using db = fixture();
    db.exec("UPDATE assignments SET kind = 'pr-feedback'; UPDATE launches SET state = 'finished'");
    db.query("UPDATE sources SET supervising_session = ?").run(session);
    db.query("UPDATE pull_requests SET parking = ?").run(
      JSON.stringify({
        launchId: "l",
        head: "h",
        at: "then",
        note: null,
        state: "parked",
        events: ["feedback"],
      }),
    );
    const before = db.serialize();
    const result = resumeParkedPullRequest(
      db,
      { repository: "owner/repo", sourceId: "s", assignment: "a" },
      undefined,
      callerSupplied ? { session: "own", pane: "own:p" } : undefined,
    );
    if (session === "foreign") {
      expect(result).toMatchObject({
        tag: "Err",
        error: {
          reason: "source_supervised_elsewhere",
          detail: "Another agent session now supervises this source. Nothing changed.",
          next: {
            decider: "super-agent",
            question:
              "Will the recorded supervisor continue, or should the person authorize a source take-over?",
          },
          state: { supervisorSession: "foreign", callerSession: callerSupplied ? "own" : null },
        },
      });
      expect(db.serialize()).toEqual(before);
    } else {
      expect(result).toMatchObject({ tag: "Ok" });
      expect(db.query("SELECT handoff_state FROM kind_handoffs").get()).toEqual({
        handoff_state: "pending",
      });
    }
  },
);

test("parking resume leaves a null kind for the atomic launch reservation to fill", () => {
  using db = fixture();
  db.exec("UPDATE launches SET state = 'finished'");
  db.query("UPDATE pull_requests SET parking = ?").run(
    JSON.stringify({
      launchId: "l",
      head: "h",
      at: "then",
      note: null,
      state: "parked",
      events: ["feedback"],
    }),
  );
  expect(
    resumeParkedPullRequest(
      db,
      { repository: "owner/repo", sourceId: "s", assignment: "a" },
      "implementation",
    ),
  ).toMatchObject({ tag: "Ok" });
  expect(db.query("SELECT kind FROM assignments").get()).toEqual({ kind: null });
  expect(db.query("SELECT id FROM launches").all()).toEqual([{ id: "l" }]);
});

test.each(["parking", "resuming", "active", "closed"])(
  "a batch excludes a %s receipt without claiming it as parked",
  (state) => {
    using db = fixture();
    db.query("UPDATE pull_requests SET parking = ?").run(
      JSON.stringify({ launchId: "l", head: "h", at: "then", note: null, state, events: [] }),
    );
    expect(claimParkedRead(db, Date.now())).toMatchObject({ tag: "Ok", value: { rows: [] } });
  },
);

test.each([
  "UPDATE sources SET state = 'reset'",
  "UPDATE assignments SET state = 'merged'",
  "UPDATE launches SET state = 'running'",
  "UPDATE launches SET id = 'replacement'",
  "UPDATE kind_handoffs SET owner_pid = 99999999",
  "UPDATE kind_handoffs SET outgoing_launch_id = 'replacement'",
])("parking completion rechecks its transaction fence: %s", (race) => {
  using db = fixture();
  expect(parkPullRequest(db, "l", { head: "h", note: null }).tag).toBe("Ok");
  db.exec("UPDATE launches SET state = 'finished'");
  db.exec(race);
  const before = db.serialize();
  expect(
    completeParking(db, { repository: "owner/repo", sourceId: "s", assignment: "a" }),
  ).toMatchObject({ tag: "Err", error: { reason: "pr_resume_refused" } });
  expect(db.serialize()).toEqual(before);
});
