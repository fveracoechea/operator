import { expect, test } from "bun:test";
import { changeCommitDelivery, commitDeliverySchema } from "./commit-deliveries.ts";
import { deliveryFixture } from "./delivery-fixture.ts";
import { insertRow } from "./state-fixture.ts";

const target = { sourceId: "s", assignment: "a" };
function published() {
  const head = "b".repeat(40);
  const tree = "c".repeat(40);
  const policy = { checks: [["git", "diff"]], review: "required", publication: "local-and-origin" };
  return commitDeliverySchema.parse({
    repository: "o/r",
    ticket: "#411",
    checkout: "/repo",
    localRef: "refs/heads/main",
    remoteRef: "refs/heads/main",
    remote: "https://github.com/o/r.git",
    base: "a".repeat(40),
    policy,
    stage: "finalize",
    implementer: "implementer",
    candidate: { path: "/candidate", branch: "candidate", tree, head },
    history: [head],
    rounds: [{ head, tree, findings: [] }],
    dispositions: [],
    publishedHead: head,
    ownerPid: null,
    leaseAt: null,
    checks: {
      candidate: head,
      tree,
      base: "a".repeat(40),
      policy: JSON.stringify(policy),
      results: [{ argv: ["git", "diff"], exitCode: 0 }],
    },
    journal: ["candidate_creation", "checkout_index", "local_ref", "remote_publication"].flatMap(
      (effect) => (["intent", "verified"] as const).map((state) => ({ effect, state, at: "now" })),
    ),
  });
}

test("storage refuses backward and skipped events, and preserves all partial-effect evidence atomically", () => {
  using db = deliveryFixture();
  db.exec(
    "DELETE FROM pull_requests; UPDATE assignments SET completion = 'commit', state = 'running'",
  );
  const before = published();
  insertRow(db, "commit_deliveries", {
    source_id: "s",
    assignment: "a",
    revision: 7,
    data: JSON.stringify(before),
  });
  const evidence = db.query("SELECT * FROM commit_deliveries").all();
  for (const change of [
    {
      ...before,
      stage: "build",
      candidate: null,
      history: [],
      implementer: null,
      rounds: [],
      checks: null,
      journal: [],
      publishedHead: null,
    },
    { ...before, stage: "remote" },
    { ...before, publishedHead: null },
    { ...before, publishedHead: "d".repeat(40) },
    { ...before, journal: before.journal.slice(1) },
    { ...before, journal: [...before.journal].reverse() },
    { ...before, candidate: { ...before.candidate, path: "/foreign" } },
    { ...before, history: [...before.history, "e".repeat(40)].reverse() },
    { ...before, implementer: "replacement" },
  ]) {
    expect(
      changeCommitDelivery(db, target, {
        revision: 7,
        data: JSON.stringify(change),
        launchId: "l",
      }),
    ).toMatchObject({
      tag: "Err",
      error: {
        reason: "commit_transition_invalid",
        detail: "Commit delivery cannot move backward, skip stages, or remove pinned evidence.",
        next: { command: "operator next", why: "Recover the retained commit-delivery evidence." },
      },
    });
    expect(db.query("SELECT * FROM commit_deliveries").all()).toEqual(evidence);
    expect(db.query("SELECT state FROM assignments").get()).toEqual({ state: "running" });
    expect(db.query("SELECT state FROM sources").get()).toEqual({ state: "open" });
    expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual([]);
  }
  expect(
    changeCommitDelivery(db, target, {
      revision: 7,
      data: JSON.stringify({
        ...before,
        journal: [
          ...before.journal,
          { effect: "database_finalization", state: "intent", at: "later" },
        ],
      }),
      launchId: "l",
    }),
  ).toMatchObject({ tag: "Ok", value: 8 });
});

test("initialization cannot fabricate a late stage or skip admission", () => {
  using db = deliveryFixture();
  db.exec(
    "DELETE FROM pull_requests; UPDATE assignments SET completion = 'commit', state = 'running'",
  );
  const data = published();
  expect(
    changeCommitDelivery(db, target, { revision: null, data: JSON.stringify(data) }),
  ).toMatchObject({
    tag: "Err",
    error: { reason: "commit_transition_invalid" },
  });
  expect(db.query("SELECT * FROM commit_deliveries").all()).toEqual([]);
  insertRow(db, "commit_deliveries", {
    source_id: "s",
    assignment: "a",
    revision: 1,
    data: JSON.stringify({ ...data, stage: "review" }),
  });
  expect(
    changeCommitDelivery(db, target, { revision: 1, data: JSON.stringify(data) }),
  ).toMatchObject({
    tag: "Err",
    error: { reason: "commit_transition_invalid" },
  });
  expect(db.query("SELECT revision FROM commit_deliveries").get()).toEqual({ revision: 1 });
});
