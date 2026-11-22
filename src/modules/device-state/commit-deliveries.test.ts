import { expect, test } from "bun:test";
import { changeCommitDelivery, commitDeliverySchema } from "./commit-deliveries.ts";
import { deliveryFixture } from "./delivery-fixture.ts";
import { insertRow, reservedCopy, busy } from "./state-fixture.ts";

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
  ).toMatchObject({ error: { reason: "commit_target_changed" } });
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
  expect(
    changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(data), complete: true })
      .tag,
  ).toBe("Ok");
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
      error: { reason: "commit_delivery_running", next: { command: "operator next --wait" } },
    });
  } finally {
    child.kill();
    await child.exited;
  }
  expect(changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(initial) }).tag).toBe(
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
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(review) }).tag,
  ).toBe("Ok");
  expect(
    changeCommitDelivery(db, target, {
      revision: 1,
      data: JSON.stringify({ ...review, stage: "checkout" }),
    }),
  ).toMatchObject({ error: { reason: "commit_merge_held", next: { decider: "person" } } });
  expect(db.query("SELECT revision FROM commit_deliveries").get()).toEqual({ revision: 1 });
  db.exec("UPDATE obligations SET state = 'closed'");
  expect(
    changeCommitDelivery(db, target, {
      revision: 1,
      data: JSON.stringify({ ...review, stage: "checkout" }),
    }).tag,
  ).toBe("Ok");
});
