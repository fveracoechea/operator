import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Ok } from "unthrown";
import { z } from "zod";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import { changeStack, readStack, restartStackReview, beginStackReview } from "./stacks.ts";
import { startHandoff } from "./internal-reviews.ts";
import { recordPullRequestQueue } from "./pr-parking.ts";

function stackDevice() {
  const client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "projects", { repository: "owner/repo", checkout: "/main" });
  insertRow(client, "sources", { id: "source", repository: "owner/repo", state: "open" });
  insertRow(client, "assignments", {
    source_id: "source",
    key: "child",
    completion: "pr",
    state: "pr-open",
  });
  for (const [id, attempt, state] of [
    ["implementer", 1, "finished"],
    ["reviewer", 2, "running"],
  ] as const)
    insertRow(client, "launches", {
      id,
      source_id: "source",
      assignment: "child",
      attempt,
      state,
      branch: "task/child",
    });
  insertRow(client, "pull_requests", {
    source_id: "source",
    assignment: "child",
    repository: "owner/repo",
    number: 8,
    branch: "task/child",
  });
  return client;
}

test("a changed stack archives an exhausted review and requires a genuinely fresh handoff", () => {
  using client = stackDevice();
  insertRow(client, "internal_reviews", {
    source_id: "source",
    assignment: "child",
    state: "ready",
    implementer_launch_id: "implementer",
    handoff_state: "done",
    ready_head: "old-head",
  });
  for (const number of [1, 2])
    insertRow(client, "internal_review_rounds", {
      source_id: "source",
      assignment: "child",
      number,
      launch_id: "reviewer",
      head: `old-${number}`,
      findings: "[]",
    });
  const created = changeStack(client, "reviewer", "operation", null, () =>
    Ok({ state: "planned", data: "{}", ownerPid: process.pid }),
  );
  expect(created).toMatchObject({ tag: "Ok", value: { revision: 1 } });
  expect(beginStackReview(client, "reviewer", "operation", 1).tag).toBe("Err");
  const restarted = restartStackReview(client, "reviewer", "operation", 1);
  expect(restarted).toMatchObject({ tag: "Ok", value: { revision: 2 } });
  const current = client
    .query("SELECT state, implementer_launch_id, ready_head FROM internal_reviews")
    .get();
  expect(current).toEqual({
    state: "reviewing",
    implementer_launch_id: "reviewer",
    ready_head: null,
  });
  expect(client.query("SELECT number FROM internal_review_rounds").all()).toEqual([]);
  const stored = readStack(client, "reviewer", "operation");
  expect(stored.tag).toBe("Ok");
  if (stored.tag !== "Ok") return;
  const history = z
    .object({
      review: z.object({ readyHead: z.string() }),
      rounds: z.array(z.object({ head: z.string() })),
    })
    .parse(JSON.parse(stored.value.reviewHistory ?? "null"));
  expect(history.review.readyHead).toBe("old-head");
  expect(history.rounds.map((row: { head: string }) => row.head)).toEqual(["old-1", "old-2"]);
  expect(restartStackReview(client, "reviewer", "operation", 2)).toMatchObject({
    tag: "Ok",
    value: { revision: 2 },
  });
});

test.each(["known", "unknown"] as const)(
  "stack invalidation archives %s readiness bytes before clearing active authority",
  (origin) => {
    using client = stackDevice();
    const receipt =
      origin === "known"
        ? {
            head: "reviewed-head",
            at: "original-at",
            note: "/original-note",
            dispositions: [
              { round: 2, finding: 1, disposition: "declined", reason: "Not applicable." },
            ],
          }
        : {
            origin: "migration-0026",
            head: null,
            at: "migration-at",
            note: null,
            dispositions: [],
          };
    const raw = JSON.stringify(receipt, null, 2);
    const progress = '{"seen":["original-comment"],"failures":[],"eligibleHead":"reviewed-head"}';
    client.query("UPDATE pull_requests SET readiness = ?, progress = ?").run(raw, progress);
    expect(
      changeStack(client, "reviewer", "operation", null, () =>
        Ok({ state: "planned", data: "{}", ownerPid: process.pid }),
      ).tag,
    ).toBe("Ok");
    const result = restartStackReview(client, "reviewer", "operation", 1);
    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(JSON.parse(result.value.reviewHistory ?? "null")).toMatchObject({
      readinessRaw: raw,
      readiness: receipt,
      progress,
    });
    expect(client.query("SELECT readiness FROM pull_requests").get()).toEqual({ readiness: null });
    expect(client.query("SELECT next_kind FROM kind_handoffs").all()).toEqual([]);
  },
);

test("a null handoff claim cannot publish a successor or authorize competing stack effects", () => {
  using client = stackDevice();
  insertRow(client, "kind_handoffs", {
    source_id: "source",
    assignment: "child",
    outgoing_launch_id: "reviewer",
    next_kind: "review",
    handoff_state: "pending",
    owner_pid: null,
    lease_at: null,
  });
  expect(startHandoff(client, "source", "child", 1).tag).toBe("Ok");
  expect(client.query("SELECT owner_pid FROM kind_handoffs").get()).toEqual({ owner_pid: null });
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: "{}", ownerPid: process.pid }),
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "stack_stale" } });
  expect(client.query("SELECT id FROM stack_operations").all()).toEqual([]);
});

test("a replacement launch can claim exact unfinished progress but the old launch cannot write it", () => {
  using client = stackDevice();
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: "original", ownerPid: null }),
    ).tag,
  ).toBe("Ok");
  client.exec("UPDATE launches SET state = 'interrupted' WHERE id = 'reviewer'");
  client.exec("UPDATE launches SET worktree_path = '/child' WHERE id = 'reviewer'");
  insertRow(client, "launches", {
    id: "replacement",
    source_id: "source",
    assignment: "child",
    attempt: 3,
    state: "running",
    branch: "task/child",
    worktree_path: "/child",
  });
  expect(
    changeStack(client, "replacement", "operation", 1, () =>
      Ok({ state: "planned", data: "replacement", ownerPid: process.pid }),
    ),
  ).toMatchObject({ tag: "Ok", value: { launchId: "replacement", revision: 2 } });
  expect(
    changeStack(client, "reviewer", "operation", 2, () =>
      Ok({ state: "complete", data: "stale", ownerPid: null }),
    ).tag,
  ).toBe("Err");
  expect(readStack(client, "replacement", "operation")).toMatchObject({
    tag: "Ok",
    value: { data: "replacement" },
  });
});

test("unresolved queue and stack effects exclude one another at transactional admission", () => {
  using client = stackDevice();
  client
    .query("UPDATE pull_requests SET parking = ?")
    .run(JSON.stringify({ queueHead: "guarded-head" }));
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: "{}", ownerPid: process.pid }),
    ),
  ).toMatchObject({
    tag: "Err",
    error: { reason: "stack_incomplete" },
  });
  expect(client.query("SELECT id FROM stack_operations").all()).toEqual([]);
  client.exec("UPDATE pull_requests SET parking = NULL");
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: "{}", ownerPid: process.pid }),
    ).tag,
  ).toBe("Ok");
  expect(recordPullRequestQueue(client, "reviewer", "guarded-head")).toMatchObject({
    tag: "Err",
    error: { reason: "stack_incomplete" },
  });
  expect(client.query("SELECT parking FROM pull_requests").get()).toEqual({ parking: null });
});

test("same-worktree replacement keeps archived review bytes and becomes the explicit outgoing stack owner", () => {
  using client = stackDevice();
  client.exec("UPDATE launches SET worktree_path = '/child' WHERE id = 'reviewer'");
  expect(
    changeStack(client, "reviewer", "operation", null, () =>
      Ok({ state: "planned", data: "{}", ownerPid: process.pid }),
    ).tag,
  ).toBe("Ok");
  const invalidated = restartStackReview(client, "reviewer", "operation", 1);
  expect(invalidated.tag).toBe("Ok");
  if (invalidated.tag !== "Ok") return;
  const archived = invalidated.value.reviewHistory;
  client.exec("UPDATE launches SET state = 'interrupted' WHERE id = 'reviewer'");
  insertRow(client, "launches", {
    id: "replacement",
    source_id: "source",
    assignment: "child",
    attempt: 3,
    state: "running",
    branch: "task/child",
    worktree_path: "/child",
  });
  expect(
    changeStack(client, "replacement", "operation", 2, () =>
      Ok({ state: "planned", data: "{}", ownerPid: process.pid }),
    ),
  ).toMatchObject({
    tag: "Ok",
    value: { launchId: "replacement", reviewHistory: archived },
  });
  expect(client.query("SELECT implementer_launch_id FROM internal_reviews").get()).toEqual({
    implementer_launch_id: "replacement",
  });
  expect(client.query("SELECT next_kind FROM kind_handoffs").all()).toEqual([]);
});
