import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsFolder } from "./database.ts";
import { worktreeOwners } from "./pull-requests.ts";
import { insertRow } from "./state-fixture.ts";

function owner(client: Database, readiness: string | null) {
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "projects", { repository: "owner/repo", checkout: "/checkout" });
  insertRow(client, "sources", { id: "s", repository: "owner/repo", state: "open" });
  insertRow(client, "assignments", {
    source_id: "s",
    key: "a",
    completion: "pr",
    state: "pr-open",
  });
  insertRow(client, "launches", {
    id: "l",
    source_id: "s",
    assignment: "a",
    attempt: 1,
    state: "running",
    worktree_path: "/worktree",
    branch: "task/a",
  });
  insertRow(client, "pull_requests", { source_id: "s", assignment: "a", readiness });
}

test.each([
  "{",
  "{}",
  "",
  "null",
  '{"head":"h","at":"now","note":null,"dispositions":[{"round":0,"finding":1,"disposition":"applied"}]}',
])("owner reads refuse corrupt readiness %j without changing state", (readiness) => {
  using client = new Database(":memory:");
  owner(client, readiness);
  const before = client.serialize();
  expect(worktreeOwners(client)).toMatchObject({
    tag: "Err",
    error: {
      reason: "state_corrupt",
      detail: "The recorded PR readiness is invalid. Nothing was changed.",
      state: { readinessValid: false },
    },
  });
  expect(client.serialize()).toEqual(before);
});

test.each([null, { head: "legacy-ready-head", at: "now", note: null, dispositions: [] }])(
  "owner reads return validated readiness %j rather than storage text",
  (readiness) => {
    using client = new Database(":memory:");
    owner(
      client,
      readiness === null ? null : JSON.stringify({ ...readiness, extra: "old metadata" }),
    );
    expect(worktreeOwners(client)).toMatchObject({ tag: "Ok", value: [{ readiness }] });
  },
);

test("owner readiness decoding preserves unexpected faults instead of diagnosing corrupt state", () => {
  using client = new Database(":memory:");
  const text = JSON.stringify({ head: "pushed", at: "now", note: null, dispositions: [] });
  owner(client, text);
  const before = client.serialize();
  const cause = new Error("unexpected decoder fault");
  const parse = JSON.parse;
  const fault = spyOn(JSON, "parse").mockImplementation((value, reviver) => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject an unexpected wire-decoder fault to verify the defect boundary.
    if (value === text) throw cause;
    const decoded: unknown = parse(value, reviver);
    return decoded;
  });
  try {
    const result = worktreeOwners(client);
    expect(result.tag).toBe("Defect");
    if (result.tag === "Defect") expect(result.cause).toBe(cause);
    expect(client.serialize()).toEqual(before);
  } finally {
    fault.mockRestore();
  }
});
