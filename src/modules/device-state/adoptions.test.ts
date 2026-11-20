import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";
import { adoptionOwner, checkAdoption } from "./adoptions.ts";

const target = {
  repository: "owner/one",
  sourceId: "new",
  assignment: "new",
  branch: "feature/own",
  number: 41,
};
function fixture() {
  const client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  return client;
}

test.each(["starting", "running", "interrupted", "failed", "finished"])(
  "a %s launch's live assignment keeps branch ownership",
  (state) => {
    using client = fixture();
    insertRow(client, "sources", { id: "other", repository: "owner/one", state: "open" });
    insertRow(client, "assignments", { source_id: "other", key: "existing", state: "running" });
    insertRow(client, "launches", {
      source_id: "other",
      assignment: "existing",
      state,
      branch: target.branch,
    });
    const before = client.serialize();
    expect(checkAdoption(client, target)).toMatchObject({
      tag: "Err",
      error: {
        reason: "adopt_assignment_owned",
        state: { sourceId: "other", assignment: "existing" },
      },
    });
    expect(client.serialize()).toEqual(before);
  },
);

test.each(["abandoned", "merged", "completed"])(
  "an ended %s assignment leaves its historical PR available",
  (state) => {
    using client = fixture();
    insertRow(client, "sources", { id: "other", repository: "owner/one", state: "open" });
    insertRow(client, "assignments", { source_id: "other", key: "existing", state });
    insertRow(client, "pull_requests", {
      source_id: "other",
      assignment: "existing",
      number: 41,
      branch: target.branch,
    });
    expect(checkAdoption(client, target)).toMatchObject({ tag: "Ok" });
  },
);

test("a live associated PR blocks even with no launch, while the same assignment can resume", () => {
  using client = fixture();
  insertRow(client, "sources", { id: "other", repository: "owner/one", state: "open" });
  insertRow(client, "assignments", { source_id: "other", key: "existing", state: "pr-open" });
  insertRow(client, "pull_requests", {
    source_id: "other",
    assignment: "existing",
    number: 41,
    branch: "old-name",
  });
  expect(adoptionOwner(drizzle(client), target)).toMatchObject({
    error: { reason: "adopt_assignment_owned" },
  });
  expect(
    checkAdoption(client, { ...target, sourceId: "other", assignment: "existing" }),
  ).toMatchObject({ tag: "Ok" });
});

test.each(["queued", "starting", "reviewing", "watching", "posted"])(
  "an open %s review request fences both PR number and branch",
  (state) => {
    using client = fixture();
    insertRow(client, "review_requests", {
      id: "request",
      repository: "owner/one",
      state,
      number: 41,
      branch: "review-branch",
    });
    expect(checkAdoption(client, target)).toMatchObject({
      error: { reason: "adopt_review_owned", state: { request: "request" } },
    });
    expect(
      checkAdoption(client, { ...target, number: null, branch: "review-branch" }),
    ).toMatchObject({ error: { reason: "adopt_review_owned" } });
  },
);

test("closed or skipped reviews and other repositories own no adoption target", () => {
  using client = fixture();
  for (const state of ["closed", "skipped"])
    insertRow(client, "review_requests", {
      repository: "owner/one",
      state,
      number: 41,
      branch: target.branch,
    });
  insertRow(client, "review_requests", {
    repository: "owner/two",
    state: "reviewing",
    number: 41,
    branch: target.branch,
  });
  insertRow(client, "sources", { id: "other", repository: "owner/two", state: "open" });
  insertRow(client, "assignments", { source_id: "other", key: "existing", state: "running" });
  insertRow(client, "launches", {
    source_id: "other",
    assignment: "existing",
    branch: target.branch,
  });
  expect(checkAdoption(client, target)).toMatchObject({ tag: "Ok" });
});
