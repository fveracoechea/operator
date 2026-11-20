import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Ok } from "unthrown";
import { z } from "zod";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import { changeStack, readStack, restartStackReview } from "./stacks.ts";
import { startHandoff } from "./internal-reviews.ts";

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
  const restarted = restartStackReview(client, "reviewer", "operation", 1);
  expect(restarted).toMatchObject({ tag: "Ok", value: { revision: 2 } });
  const current = client
    .query("SELECT state, implementer_launch_id, handoff_state, ready_head FROM internal_reviews")
    .get();
  expect(current).toEqual({
    state: "reviewing",
    implementer_launch_id: "reviewer",
    handoff_state: "pending",
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

test("a stack-created review transfers its null handoff claim and blocks competing stack effects", () => {
  using client = stackDevice();
  insertRow(client, "internal_reviews", {
    source_id: "source",
    assignment: "child",
    state: "reviewing",
    implementer_launch_id: "reviewer",
    handoff_state: "pending",
    owner_pid: null,
    lease_at: null,
  });
  expect(startHandoff(client, "source", "child", 1).tag).toBe("Ok");
  expect(client.query("SELECT owner_pid FROM internal_reviews").get()).toEqual({ owner_pid: 1 });
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
