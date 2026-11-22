import { expect, test } from "bun:test";
import { changeCommitDelivery, commitDeliverySchema } from "./commit-deliveries.ts";
import { deliveryFixture } from "./delivery-fixture.ts";
import { insertRow, reservedCopy, busy } from "./state-fixture.ts";
import type { Refusal } from "../../lib/cli-result.ts";

const target = { sourceId: "s", assignment: "a" };
const initial = {
  repository: "o/r",
  ticket: "#411",
  checkout: "/repo",
  localRef: "refs/heads/main",
  remoteRef: "refs/heads/main",
  remote: "https://github.com/o/r.git",
  base: "a".repeat(40),
  publishedHead: null,
  policy: {
    checks: [["git", "diff", "--exit-code"]],
    review: "required",
    publication: "local-and-origin",
  },
  candidate: null,
  history: [],
  implementer: null,
  rounds: [],
  dispositions: [],
  checks: null,
  journal: [],
  stage: "build",
  ownerPid: null,
  leaseAt: null,
};

function fixture() {
  const db = deliveryFixture();
  db.exec(
    "DELETE FROM pull_requests; UPDATE assignments SET completion = 'commit', state = 'running'",
  );
  return db;
}

function completed() {
  const head = "b".repeat(40);
  const tree = "c".repeat(40);
  return {
    ...initial,
    stage: "complete",
    implementer: "implementer",
    candidate: { path: "/candidate", branch: "candidate/411", head, tree },
    history: [head],
    rounds: [{ head, tree, findings: [] }],
    publishedHead: head,
    checks: {
      candidate: head,
      base: initial.base,
      tree,
      policy: JSON.stringify(initial.policy),
      results: [{ argv: initial.policy.checks[0], exitCode: 0 }],
    },
    journal: [
      "candidate_creation",
      "checkout_index",
      "local_ref",
      "remote_publication",
      "database_finalization",
    ].map((effect) => ({ effect, state: "verified", at: "now" })),
  };
}

function finish(db: ReturnType<typeof fixture>, data = completed()) {
  let revision = 1;
  for (const stage of ["review", "checkout", "local", "remote", "finalize"]) {
    expect(
      changeCommitDelivery(db, target, {
        revision,
        data: JSON.stringify({ ...data, stage }),
      }).tag,
    ).toBe("Ok");
    revision++;
  }
  return changeCommitDelivery(db, target, {
    revision,
    data: JSON.stringify(data),
    complete: true,
  });
}

function expectRefusal(
  result: ReturnType<typeof changeCommitDelivery>,
  reason: string,
  next: Refusal["next"],
) {
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason,
      detail: expect.stringMatching(/\S/) as string,
      next,
    },
  });
}

test.each([
  ["report", "completed", "finished"],
  ["pr", "merged", "finished"],
  ["pr", "pr-open", "open"],
  ["report", "reported", "open"],
  ["commit", "completed", "finished"],
])(
  "finalization with another %s assignment in %s leaves the source %s",
  (completion, state, expected) => {
    using db = fixture();
    insertRow(db, "assignments", { source_id: "s", key: "other", completion, state });
    expect(
      changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }).tag,
    ).toBe("Ok");
    expect(finish(db).tag).toBe("Ok");
    expect(db.query("SELECT state FROM sources").get()).toEqual({ state: expected });
    const row = db.query<{ ended_at: string | null }, []>("SELECT ended_at FROM sources").get();
    expect(row?.ended_at === null).toBe(expected === "open");
  },
);

test("missing or ended parents and changed completion refuse without writing evidence", () => {
  using db = fixture();
  const recovery = { command: "operator next", why: expect.stringMatching(/\S/) as string };
  expectRefusal(
    changeCommitDelivery(
      db,
      { ...target, sourceId: "missing" },
      { revision: null, data: JSON.stringify(initial) },
    ),
    "commit_state_changed",
    recovery,
  );
  expectRefusal(
    changeCommitDelivery(
      db,
      { ...target, assignment: "missing" },
      { revision: null, data: JSON.stringify(initial) },
    ),
    "commit_state_changed",
    recovery,
  );
  db.exec("UPDATE sources SET state = 'reset'");
  expectRefusal(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }),
    "commit_state_changed",
    recovery,
  );
  db.exec("UPDATE sources SET state = 'open'; UPDATE assignments SET completion = 'report'");
  expectRefusal(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }),
    "commit_state_changed",
    recovery,
  );
  expect(db.query("SELECT * FROM commit_deliveries").all()).toEqual([]);
});

test("finalization cannot separate the terminal receipt from its assignment update", () => {
  using db = fixture();
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }).tag,
  ).toBe("Ok");
  for (const change of [
    { revision: 1, data: JSON.stringify(initial), complete: true },
    { revision: 1, data: JSON.stringify(completed()) },
  ])
    expectRefusal(changeCommitDelivery(db, target, change), "commit_state_changed", {
      command: "operator next",
      why: "Recover the recorded finalization.",
    });
  expect(db.query("SELECT revision FROM commit_deliveries").get()).toEqual({ revision: 1 });
  expect(db.query("SELECT state FROM assignments").get()).toEqual({ state: "running" });
});

test("handoff reservation and evidence change together, and missing launch owners refuse", () => {
  using db = fixture();
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }).tag,
  ).toBe("Ok");
  const review = { ...completed(), stage: "review" };
  expect(
    changeCommitDelivery(db, target, {
      revision: 1,
      data: JSON.stringify(review),
      launchId: "l",
      handoff: "commit-review",
    }).tag,
  ).toBe("Ok");
  expect(db.query("SELECT outgoing_launch_id, next_kind FROM kind_handoffs").get()).toEqual({
    outgoing_launch_id: "l",
    next_kind: "commit-review",
  });
  db.exec("DELETE FROM launches");
  expectRefusal(
    changeCommitDelivery(db, target, { revision: 2, data: JSON.stringify(review), launchId: "l" }),
    "commit_owner_inactive",
    {
      command: "operator next",
      why: "Recover the recorded worker.",
    },
  );
  expect(db.query("SELECT revision FROM commit_deliveries").get()).toEqual({ revision: 2 });
});

test("handoff reservation requires an explicit current worker", () => {
  using db = fixture();
  expectRefusal(
    changeCommitDelivery(db, target, {
      revision: null,
      data: JSON.stringify(initial),
      handoff: "commit-review",
    }),
    "commit_owner_inactive",
    { command: "operator next", why: "Recover the recorded worker." },
  );
  expect(db.query("SELECT * FROM commit_deliveries").all()).toEqual([]);
  expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual([]);
});

test("completion closes only this ticket's open conversations", () => {
  using db = fixture();
  insertRow(db, "worker_questions", {
    source_id: "s",
    assignment: "a",
    key: "scope",
    launch_id: "l",
    state: "open",
  });
  insertRow(db, "worker_messages", {
    source_id: "s",
    assignment: "a",
    key: "steering",
    launch_id: "l",
    state: "pending",
  });
  insertRow(db, "assignments", {
    source_id: "s",
    key: "other",
    completion: "report",
    state: "running",
  });
  insertRow(db, "worker_questions", {
    source_id: "s",
    assignment: "other",
    key: "other-scope",
    launch_id: "other-launch",
    state: "open",
  });
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }).tag,
  ).toBe("Ok");
  expect(finish(db).tag).toBe("Ok");
  expect(db.query("SELECT key, state FROM worker_questions ORDER BY key").all()).toEqual([
    { key: "other-scope", state: "open" },
    { key: "scope", state: "abandoned" },
  ]);
  expect(db.query("SELECT state FROM worker_messages").get()).toEqual({ state: "abandoned" });
});

test("commit evidence cannot finalize an unreviewed and unpublished ticket", () => {
  using db = fixture();
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }).tag,
  ).toBe("Ok");
  expect(() => commitDeliverySchema.parse({ ...initial, stage: "complete" })).toThrow();
});

test("commit writes reserve the transaction, retain revisions, and pin target policy", () => {
  using db = fixture();
  using held = reservedCopy(db);
  expect(
    changeCommitDelivery(held.subject, target, { revision: null, data: JSON.stringify(initial) }),
  ).toMatchObject(busy);
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }),
  ).toMatchObject({ tag: "Ok", value: 1 });
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }),
  ).toMatchObject({ error: { reason: "commit_state_changed" } });
  expect(
    changeCommitDelivery(db, target, {
      revision: 1,
      data: JSON.stringify({ ...initial, base: "b".repeat(40) }),
    }),
  ).toMatchObject({
    error: {
      reason: "commit_target_changed",
      detail: expect.stringMatching(/\S/) as string,
      next: { command: "operator next", why: expect.stringMatching(/\S/) as string },
    },
  });
  expect(db.query("SELECT revision FROM commit_deliveries").get()).toEqual({ revision: 1 });
});

test("finalization derives source completion from current assignments in the same transaction", () => {
  using db = fixture();
  insertRow(db, "assignments", {
    source_id: "s",
    key: "other",
    completion: "report",
    state: "running",
  });
  const candidate = {
    path: "/candidate",
    branch: "operator/candidate",
    head: "b".repeat(40),
    tree: "c".repeat(40),
  };
  const journal = [
    "candidate_creation",
    "checkout_index",
    "local_ref",
    "remote_publication",
    "database_finalization",
  ].flatMap((effect) =>
    (["intent", "verified"] as const).map((state) => ({ effect, state, at: "now" })),
  );
  const data = {
    ...initial,
    stage: "complete",
    candidate,
    history: [candidate.head],
    implementer: "implementer",
    rounds: [{ head: candidate.head, tree: candidate.tree, findings: [] }],
    checks: {
      candidate: candidate.head,
      base: initial.base,
      tree: candidate.tree,
      policy: JSON.stringify(initial.policy),
      results: [{ argv: initial.policy.checks[0], exitCode: 0 }],
    },
    publishedHead: candidate.head,
    journal,
  };
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }).tag,
  ).toBe("Ok");
  expect(finish(db, data).tag).toBe("Ok");
  expect(db.query("SELECT state, ended_at FROM sources").get()).toEqual({
    state: "open",
    ended_at: null,
  });
  expect(db.query("SELECT state FROM assignments WHERE key = 'a'").get()).toEqual({
    state: "completed",
  });
});

test("stopped or superseded workers cannot replace commit evidence", () => {
  using db = fixture();
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(initial) }).tag,
  ).toBe("Ok");
  for (const launchId of ["missing", "previous"])
    expect(
      changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(initial), launchId }),
    ).toMatchObject({
      error: { reason: "commit_owner_inactive", next: { command: "operator next" } },
    });
  expect(
    changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(initial), launchId: "l" })
      .tag,
  ).toBe("Ok");
  db.exec("UPDATE launches SET state = 'interrupted'");
  expect(
    changeCommitDelivery(db, target, { revision: 2, data: JSON.stringify(initial), launchId: "l" }),
  ).toMatchObject({ error: { reason: "commit_owner_inactive" } });
  expect(db.query("SELECT revision FROM commit_deliveries").get()).toEqual({ revision: 2 });
});

test("a live competing process owns the candidate until its process ends", async () => {
  using db = fixture();
  const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const held = { ...initial, ownerPid: child.pid, leaseAt: new Date().toISOString() };
    expect(
      changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(held) }).tag,
    ).toBe("Ok");
    expect(
      changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(initial) }),
    ).toMatchObject({
      error: {
        reason: "commit_delivery_running",
        detail: expect.stringMatching(/\S/) as string,
        next: { command: "operator next --wait", why: expect.stringMatching(/\S/) as string },
      },
    });
  } finally {
    child.kill();
    await child.exited;
  }
  expect(changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(initial) }).tag).toBe(
    "Ok",
  );
});

test("the current process renews and releases its own live lease", () => {
  using db = fixture();
  const owned = { ...initial, ownerPid: process.pid, leaseAt: new Date().toISOString() };
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(owned) }).tag,
  ).toBe("Ok");
  expect(changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(owned) }).tag).toBe(
    "Ok",
  );
  expect(changeCommitDelivery(db, target, { revision: 2, data: JSON.stringify(initial) }).tag).toBe(
    "Ok",
  );
});

test("an open merge hold prevents checkout admission but not recording the fresh review", () => {
  using db = fixture();
  const head = "b".repeat(40);
  const tree = "c".repeat(40);
  const review = {
    ...initial,
    stage: "review",
    implementer: "implementer",
    candidate: { path: "/candidate", branch: "candidate/411", tree, head },
    history: [head],
    rounds: [{ head, tree, findings: [] }],
    checks: {
      candidate: head,
      tree,
      base: initial.base,
      policy: JSON.stringify(initial.policy),
      results: [{ argv: initial.policy.checks[0], exitCode: 0 }],
    },
  };
  insertRow(db, "obligations", { source_id: "s", key: "pause", kind: "merge-hold", state: "open" });
  insertRow(db, "commit_deliveries", {
    source_id: "s",
    assignment: "a",
    revision: 1,
    data: JSON.stringify(review),
  });
  expect(changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(review) }).tag).toBe(
    "Ok",
  );
  expect(
    changeCommitDelivery(db, target, {
      revision: 2,
      data: JSON.stringify({ ...review, stage: "checkout" }),
    }),
  ).toMatchObject({
    error: {
      reason: "commit_merge_held",
      detail: expect.stringMatching(/\S/) as string,
      next: { decider: "person", question: expect.stringMatching(/\S/) as string },
    },
  });
  expect(db.query("SELECT revision FROM commit_deliveries").get()).toEqual({ revision: 2 });
  db.exec("UPDATE obligations SET state = 'closed'");
  expect(
    changeCommitDelivery(db, target, {
      revision: 2,
      data: JSON.stringify({ ...review, stage: "checkout" }),
    }).tag,
  ).toBe("Ok");
  db.exec("UPDATE obligations SET state = 'open'");
  expect(
    changeCommitDelivery(db, target, {
      revision: 3,
      data: JSON.stringify({ ...review, stage: "checkout" }),
    }).tag,
  ).toBe("Ok");
});
