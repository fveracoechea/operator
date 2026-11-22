import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import { recordPrReady } from "./pr-readiness.ts";
import {
  inspectContinuation,
  readContinuation,
  reservedContinuation,
  validateContinuation,
  type HandoffContinuation,
} from "./handoff-continuation.ts";
import {
  assignments,
  kindHandoffs,
  launches,
  projects,
  pullRequests,
  sources,
  workerMessages,
} from "./schema.ts";

const target = { repository: "owner/repo", sourceId: "s1", assignment: "build" };
const context = { pane: "worker", socket: "/fixture.sock" };
const identity: HandoffContinuation = {
  ...target,
  ...context,
  outgoingLaunchId: "outgoing",
  startedAt: "2026-11-17T00:00:00.000Z",
  nextKind: "review",
};
const refusal = {
  tag: "Err",
  error: {
    reason: "handoff_continuation_refused",
    detail:
      "This process no longer owns the exact pending kind handoff. No continuation effect was authorized.",
    next: {
      command: "operator next",
      why: "The supervisor can recover the recorded failed or stopped handoff.",
    },
    state: { continuationAuthorized: false },
  },
};

test.each([
  ["commit", "running", true],
  ["commit", "ready", false],
  ["commit", "completed", false],
  ["commit", "pr-open", false],
  ["report", "running", false],
  ["pr", "running", false],
] as const)(
  "commit continuation with %s/%s is authorized=%s without writes",
  (completion, state, allowed) => {
    using client = new Database(":memory:");
    const db = seed(client, null, "review");
    client.query("UPDATE assignments SET completion = ?, state = ?").run(completion, state);
    const before = client.serialize();
    expect(inspectContinuation(db, target, context).tag).toBe(allowed ? "Ok" : "Err");
    expect(client.serialize()).toEqual(before);
  },
);

test("same-kind feedback continuation needs the exact durable parking or resume receipt", () => {
  using client = new Database(":memory:");
  const db = seed(client, JSON.stringify(WorkerKinds.resolve("pr-feedback")), "pr-feedback");
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  insertRow(client, "pull_requests", {
    source_id: target.sourceId,
    assignment: target.assignment,
    parking: JSON.stringify({ launchId: "outgoing", state: "parking" }),
  });
  expect(inspectContinuation(db, target, context)).toMatchObject({
    tag: "Ok",
    value: { identity: { ...identity, nextKind: "pr-feedback" } },
  });
  for (const state of ["parked", "active", "closed"]) {
    client
      .query("UPDATE pull_requests SET parking = ?")
      .run(JSON.stringify({ launchId: "outgoing", state }));
    expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  }
  client
    .query("UPDATE pull_requests SET parking = ?")
    .run(JSON.stringify({ launchId: "outgoing", state: "resuming" }));
  expect(inspectContinuation(db, target, context)).toMatchObject({ tag: "Ok" });
  client
    .query("UPDATE pull_requests SET parking = ?")
    .run(JSON.stringify({ launchId: "different", state: "resuming" }));
  const before = client.serialize();
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

function seed(
  client: Database,
  kind: string | null = JSON.stringify(WorkerKinds.resolve("implementation")),
  nextKind = "review",
) {
  const db = drizzle(client);
  migrate(db, { migrationsFolder });
  db.insert(projects)
    .values({ repository: target.repository, checkout: "/checkout", registeredAt: "now" })
    .run();
  db.insert(sources)
    .values({
      id: target.sourceId,
      repository: target.repository,
      trackerKey: "issue",
      plan: "{}",
      state: "open",
      registeredAt: "now",
      supervisingPane: "supervisor",
      supervisingSession: "ses_supervisor",
    })
    .run();
  db.insert(assignments)
    .values({
      sourceId: target.sourceId,
      key: target.assignment,
      completion: "pr",
      state: "pr-open",
    })
    .run();
  db.insert(launches)
    .values({
      id: "outgoing",
      sourceId: target.sourceId,
      assignment: target.assignment,
      attempt: 1,
      name: "builder",
      state: "running",
      resources: "worktree",
      branch: "task/build",
      paneId: context.pane,
      herdrSocket: context.socket,
      kind,
      host: "opencode",
      model: "fixture",
      requestedModel: "fixture",
      reasoningEffort: "medium",
      release: '{"version":"fixture"}',
      skills: "[]",
      startedAt: "2026-11-17T00:00:00.000Z",
    })
    .run();
  db.insert(kindHandoffs)
    .values({
      sourceId: target.sourceId,
      assignment: target.assignment,
      outgoingLaunchId: "outgoing",
      nextKind,
      handoffState: "pending",
      startedAt: identity.startedAt,
      updatedAt: "now",
      ownerPid: process.pid,
      leaseAt: new Date().toISOString(),
    })
    .run();
  return db;
}

test.each(["configured", "default", "legacy"])(
  "%s successor authorizes the exact recorded continuation read-only",
  (mode) => {
    using client = new Database(":memory:");
    const kind =
      mode === "legacy"
        ? null
        : JSON.stringify({
            ...WorkerKinds.resolve("implementation"),
            name: "custom-build",
            nextKind: mode === "configured" ? "custom-review" : null,
          });
    const nextKind = mode === "configured" ? "custom-review" : "review";
    const db = seed(client, kind, nextKind);
    const expected = { ...identity, nextKind };
    const before = client.serialize();
    expect(inspectContinuation(db, target, context)).toMatchObject({
      tag: "Ok",
      value: { identity: expected, published: true },
    });
    expect(readContinuation(client, target, context, process.ppid)).toMatchObject({
      tag: "Ok",
      value: { identity: expected, published: true },
    });
    expect(validateContinuation(db, expected)).toMatchObject({ tag: "Ok" });
    expect(
      reservedContinuation(db, expected, target.repository, {
        ...target,
        kind: JSON.stringify({ ...WorkerKinds.resolve("review"), name: nextKind }),
      }),
    ).toMatchObject({ tag: "Ok" });
    expect(client.serialize()).toEqual(before);
  },
);

test.each(["pr-feedback", "implementation"])(
  "legacy continuation refuses recorded %s instead of the association default",
  (nextKind) => {
    using client = new Database(":memory:");
    const db = seed(client, null, nextKind);
    const expected = { ...identity, nextKind };
    const before = client.serialize();
    expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
    expect(readContinuation(client, target, context, process.ppid)).toMatchObject(refusal);
    expect(validateContinuation(db, expected)).toMatchObject(refusal);
    expect(
      reservedContinuation(db, expected, target.repository, {
        ...target,
        kind: JSON.stringify(WorkerKinds.resolve(nextKind)),
      }),
    ).toMatchObject(refusal);
    expect(client.serialize()).toEqual(before);
  },
);

test.each(["custom", "legacy"])(
  "a typed ready receipt authorizes %s feedback without changing its snapshot",
  (mode) => {
    using client = new Database(":memory:");
    const kind =
      mode === "legacy"
        ? null
        : JSON.stringify({
            ...WorkerKinds.resolve("implementation"),
            name: "custom",
            nextKind: null,
          });
    const db = seed(client, kind);
    client.exec("UPDATE kind_handoffs SET handoff_state = 'done'");
    db.insert(pullRequests)
      .values({
        ...target,
        number: 7,
        url: "https://github.com/owner/repo/pull/7",
        branch: "task/build",
        associatedAt: "now",
        progress: "{}",
        waitState: "idle",
      })
      .run();
    const at = new Date().toISOString();
    expect(
      recordPrReady(
        db,
        { ...target, launchId: "outgoing" },
        {
          head: "pushed",
          at,
          note: null,
          dispositions: [],
        },
        "pr-feedback",
      ),
    ).toMatchObject({ tag: "Ok" });
    const checked = { ...identity, startedAt: at, nextKind: "pr-feedback" };
    expect(inspectContinuation(db, target, context)).toMatchObject({
      tag: "Ok",
      value: { identity: checked, published: true },
    });
    expect(db.select().from(launches).get()?.kind).toBe(kind);
    client.exec("UPDATE kind_handoffs SET started_at = 'replayed'");
    expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  },
);

test("a ready receipt from another PR branch refuses continuation without writes", () => {
  using client = new Database(":memory:");
  const db = seed(client, JSON.stringify(WorkerKinds.resolve("review")), "pr-feedback");
  const at = new Date().toISOString();
  db.insert(pullRequests)
    .values({
      ...target,
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      branch: "task/another-assignment",
      associatedAt: "now",
      progress: "{}",
      waitState: "idle",
      readiness: JSON.stringify({ head: "pushed", at, note: null, dispositions: [] }),
    })
    .run();
  client.query("UPDATE kind_handoffs SET started_at = ?").run(at);
  const checked = { ...identity, startedAt: at, nextKind: "pr-feedback" };
  const before = client.serialize();
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  expect(readContinuation(client, target, context, process.ppid)).toMatchObject(refusal);
  expect(validateContinuation(db, checked)).toMatchObject(refusal);
  expect(
    reservedContinuation(db, checked, target.repository, {
      ...target,
      kind: JSON.stringify(WorkerKinds.resolve("pr-feedback")),
    }),
  ).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

test.each([
  ["missing readiness", "UPDATE pull_requests SET readiness = NULL"],
  ["another repository", "UPDATE pull_requests SET repository = 'other/repo'"],
  ["a later outgoing launch", "UPDATE launches SET started_at = '2999-01-01'"],
] as const)("feedback continuation refuses %s without writes", (_name, change) => {
  using client = new Database(":memory:");
  const db = seed(client, JSON.stringify(WorkerKinds.resolve("review")), "pr-feedback");
  db.insert(pullRequests)
    .values({
      ...target,
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      branch: "task/build",
      associatedAt: "now",
      progress: "{}",
      waitState: "idle",
      readiness: JSON.stringify({
        head: "pushed",
        at: identity.startedAt,
        note: null,
        dispositions: [],
      }),
    })
    .run();
  const checked = { ...identity, nextKind: "pr-feedback" };
  expect(inspectContinuation(db, target, context)).toMatchObject({
    tag: "Ok",
    value: { identity: checked },
  });
  client.exec(change);
  const before = client.serialize();
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  expect(validateContinuation(db, checked)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

test("publication PID can observe but cannot authorize effects until this process owns the hold", () => {
  using client = new Database(":memory:");
  const db = seed(client);
  client.query("UPDATE kind_handoffs SET owner_pid = ?").run(process.ppid);
  const before = client.serialize();
  expect(inspectContinuation(db, target, context, { publishingPid: process.ppid })).toMatchObject({
    tag: "Ok",
    value: { identity, published: false },
  });
  expect(readContinuation(client, target, context, process.ppid)).toMatchObject({
    tag: "Ok",
    value: { identity, published: false },
  });
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  expect(inspectContinuation(db, target, context, { publishingPid: 0 })).toMatchObject(refusal);
  expect(inspectContinuation(db, target, context, { publishingPid: process.pid })).toMatchObject(
    refusal,
  );
  expect(validateContinuation(db, identity)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
  client.query("UPDATE kind_handoffs SET owner_pid = ?").run(process.pid);
  expect(validateContinuation(db, identity)).toMatchObject({ tag: "Ok" });
});

test("a continuation read needs no write reservation on a query-only connection", () => {
  using client = new Database(":memory:");
  seed(client);
  client.exec("PRAGMA query_only = ON");
  const before = client.serialize();
  expect(readContinuation(client, target, context, process.ppid)).toMatchObject({
    tag: "Ok",
    value: { identity, published: true },
  });
  expect(client.inTransaction).toBe(false);
  expect(client.serialize()).toEqual(before);
});

test("a process-group owner is not a positive publication PID", () => {
  using client = new Database(":memory:");
  const db = seed(client);
  client.exec("UPDATE kind_handoffs SET owner_pid = 0");
  const before = client.serialize();
  expect(inspectContinuation(db, target, context, { publishingPid: 0 })).toMatchObject(refusal);
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  expect(readContinuation(client, target, context, 0)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

test("a corrupt recovery receipt cannot authorize the outgoing worker through its kind snapshot", () => {
  using client = new Database(":memory:");
  const db = seed(client);
  db.insert(workerMessages)
    .values({
      sourceId: target.sourceId,
      assignment: target.assignment,
      key: "internal-review:recovery",
      launchId: identity.outgoingLaunchId,
      message: "{",
      sentAt: identity.startedAt,
      state: "pending",
    })
    .run();
  const before = client.serialize();
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  expect(validateContinuation(db, identity)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

test("a gone publication process cannot hold a fresh continuation lease", async () => {
  const publisher = Bun.spawn([process.execPath, "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await publisher.exited).toBe(0);
  using client = new Database(":memory:");
  const db = seed(client);
  client.query("UPDATE kind_handoffs SET owner_pid = ?").run(publisher.pid);
  const before = client.serialize();
  expect(inspectContinuation(db, target, context, { publishingPid: publisher.pid })).toMatchObject(
    refusal,
  );
  expect(client.serialize()).toEqual(before);
});

test.each([
  ["missing handoff", "DELETE FROM kind_handoffs"],
  ["ended source", "UPDATE sources SET state = 'reset'"],
  ["wrong completion", "UPDATE assignments SET completion = 'report'"],
  ["inactive assignment", "UPDATE assignments SET state = 'abandoned'"],
  ["failed handoff", "UPDATE kind_handoffs SET handoff_state = 'failed'"],
  ["done handoff", "UPDATE kind_handoffs SET handoff_state = 'done'"],
  ["wrong outgoing", "UPDATE kind_handoffs SET outgoing_launch_id = 'other'"],
  ["starting outgoing", "UPDATE launches SET state = 'starting'"],
  ["failed outgoing", "UPDATE launches SET state = 'failed'"],
  ["missing outgoing", "DELETE FROM launches"],
  ["stale lease", "UPDATE kind_handoffs SET lease_at = '2000-01-01'"],
  ["future lease", "UPDATE kind_handoffs SET lease_at = '2999-01-01'"],
  ["malformed lease", "UPDATE kind_handoffs SET lease_at = 'not-a-date'"],
  ["absent lease", "UPDATE kind_handoffs SET lease_at = NULL"],
  ["absent owner", "UPDATE kind_handoffs SET owner_pid = NULL"],
  ["incompatible target", "UPDATE kind_handoffs SET next_kind = 'research'"],
  ["different PR target", "UPDATE kind_handoffs SET next_kind = 'pr-feedback'"],
  ["unknown target", "UPDATE kind_handoffs SET next_kind = 'unknown'"],
] as const)("%s refuses inspection and effect validation without writes", (_name, change) => {
  using client = new Database(":memory:");
  const db = seed(client);
  client.exec(change);
  const before = client.serialize();
  expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
  expect(validateContinuation(db, identity)).toMatchObject(refusal);
  expect(
    reservedContinuation(db, identity, target.repository, {
      ...target,
      kind: JSON.stringify(WorkerKinds.resolve("review")),
    }),
  ).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

test.each([
  "repository",
  "sourceId",
  "assignment",
  "outgoingLaunchId",
  "startedAt",
  "nextKind",
  "pane",
  "socket",
] as const)("a changed %s identity cannot reuse an authorization", (field) => {
  using client = new Database(":memory:");
  const db = seed(client);
  const changed = { ...identity, [field]: "different" };
  const before = client.serialize();
  expect(inspectContinuation(db, target, context, { expected: changed })).toMatchObject(refusal);
  expect(validateContinuation(db, changed)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

test.each([null, "other"])("pane and socket must both match, including %s context", (value) => {
  using client = new Database(":memory:");
  const db = seed(client);
  const before = client.serialize();
  expect(inspectContinuation(db, target, { ...context, pane: value })).toMatchObject(refusal);
  expect(inspectContinuation(db, target, { ...context, socket: value })).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});

test.each(["pane", "socket", "both"])(
  "missing %s context refuses even when the outgoing launch has the same missing fields",
  (field) => {
    using client = new Database(":memory:");
    const db = seed(client);
    const missing = {
      pane: field === "socket" ? context.pane : null,
      socket: field === "pane" ? context.socket : null,
    };
    client
      .query("UPDATE launches SET pane_id = ?, herdr_socket = ?")
      .run(missing.pane, missing.socket);
    const before = client.serialize();
    expect(inspectContinuation(db, target, missing)).toMatchObject(refusal);
    expect(readContinuation(client, target, missing, process.ppid)).toMatchObject(refusal);
    expect(client.serialize()).toEqual(before);
  },
);

test.each(["pr", "report"])(
  "a report-kind outgoing cannot continue a %s assignment into review",
  (completion) => {
    using client = new Database(":memory:");
    const db = seed(client, JSON.stringify(WorkerKinds.resolve("research")));
    client.query("UPDATE assignments SET completion = ?").run(completion);
    const before = client.serialize();
    expect(inspectContinuation(db, target, context)).toMatchObject(refusal);
    expect(validateContinuation(db, identity)).toMatchObject(refusal);
    expect(client.serialize()).toEqual(before);
  },
);

test("later launches and snapshot edits invalidate an existing continuation", () => {
  using client = new Database(":memory:");
  const db = seed(client);
  expect(validateContinuation(db, identity)).toMatchObject({ tag: "Ok" });
  client
    .query("UPDATE launches SET kind = ?")
    .run(JSON.stringify({ ...WorkerKinds.resolve("implementation"), nextKind: "pr-feedback" }));
  const edited = client.serialize();
  expect(validateContinuation(db, identity)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(edited);
  client
    .query("UPDATE launches SET kind = ?")
    .run(JSON.stringify(WorkerKinds.resolve("implementation")));
  const outgoing = db.select().from(launches).get();
  if (outgoing === undefined)
    return expect.unreachable("The fixture must have an outgoing launch.");
  db.insert(launches)
    .values({ ...outgoing, id: "later", name: "later", attempt: 2 })
    .run();
  const later = client.serialize();
  expect(validateContinuation(db, identity)).toMatchObject(refusal);
  expect(client.serialize()).toEqual(later);
});

test.each(["running", "interrupted", "finished"])(
  "%s outgoing keeps authorization but reservation must retain the exact target",
  (state) => {
    using client = new Database(":memory:");
    const db = seed(client);
    client.query("UPDATE launches SET state = ?").run(state);
    const before = client.serialize();
    expect(validateContinuation(db, identity)).toMatchObject({ tag: "Ok" });
    expect(validateContinuation(db, undefined)).toMatchObject({ tag: "Ok" });
    expect(reservedContinuation(db, undefined, target.repository, target)).toMatchObject({
      tag: "Ok",
    });
    for (const kind of [null, undefined, JSON.stringify(WorkerKinds.resolve("pr-feedback"))])
      expect(
        reservedContinuation(db, identity, target.repository, { ...target, kind }),
      ).toMatchObject(refusal);
    expect(
      reservedContinuation(db, identity, "other/repo", {
        ...target,
        kind: JSON.stringify(WorkerKinds.resolve("review")),
      }),
    ).toMatchObject(refusal);
    expect(client.serialize()).toEqual(before);
  },
);

test.each([
  "valid",
  "missing",
  "malformed",
  "wrong launch",
  "wrong repository",
  "wrong assignment",
  "wrong timestamp",
  "wrong target",
])("promotion recovery receipt %s gates supervisor-pane continuation", (mode) => {
  using client = new Database(":memory:");
  const db = seed(
    client,
    JSON.stringify(WorkerKinds.resolve("research")),
    mode === "wrong target" ? "pr-feedback" : "review",
  );
  if (mode !== "missing") {
    const receipt = {
      ...target,
      implementerLaunchId: mode === "wrong launch" ? "other" : "outgoing",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      branch: "task/build",
      worktreePath: "/worktree",
      head: "a".repeat(40),
      personInstructed: true,
      authorizedAt: identity.startedAt,
      repository: mode === "wrong repository" ? "other/repo" : target.repository,
      assignment: mode === "wrong assignment" ? "other" : target.assignment,
    };
    db.insert(workerMessages)
      .values({
        sourceId: target.sourceId,
        assignment: target.assignment,
        key: "internal-review:recovery",
        launchId: "outgoing",
        message:
          mode === "malformed"
            ? "{"
            : JSON.stringify({
                version: 1,
                instruction:
                  "Stop implementation and hand over this assignment for a fresh internal review.",
                receipt,
              }),
        sentAt: mode === "wrong timestamp" ? "different" : identity.startedAt,
        state: "pending",
      })
      .run();
  }
  const before = client.serialize();
  const result = inspectContinuation(db, target, { ...context, pane: "supervisor" });
  if (mode === "valid") {
    expect(result).toMatchObject({
      tag: "Ok",
      value: { identity: { ...identity, pane: "supervisor" }, published: true },
    });
    expect(validateContinuation(db, { ...identity, pane: "supervisor" })).toMatchObject({
      tag: "Ok",
    });
    expect(inspectContinuation(db, target, { ...context, pane: "other" })).toMatchObject(refusal);
  } else expect(result).toMatchObject(refusal);
  expect(client.serialize()).toEqual(before);
});
