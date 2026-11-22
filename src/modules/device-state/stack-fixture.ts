import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { PrStacks } from "../pr-stacks/main.ts";
import { migrationsFolder } from "./database.ts";
import { insertRow } from "./state-fixture.ts";

export function stackStateFixture() {
  const client = new Database(":memory:");
  migrate(drizzle(client), { migrationsFolder });
  insertRow(client, "projects", { repository: "owner/repo", checkout: "/repo" });
  insertRow(client, "sources", {
    id: "source",
    repository: "owner/repo",
    state: "open",
    plan: JSON.stringify({
      assignments: [
        { key: "root", dependencies: [] },
        { key: "left", dependencies: ["root"] },
        { key: "right", dependencies: ["root"] },
      ],
    }),
  });
  for (const [key, number] of [
    ["root", 6],
    ["left", 8],
    ["right", 9],
  ] as const) {
    insertRow(client, "assignments", {
      source_id: "source",
      key,
      completion: "pr",
      state: "pr-open",
    });
    insertRow(client, "launches", {
      id: key,
      source_id: "source",
      assignment: key,
      attempt: 1,
      state: "running",
      branch: `task/${key}`,
      worktree_path: `/${key}`,
    });
    insertRow(client, "pull_requests", {
      source_id: "source",
      assignment: key,
      repository: "owner/repo",
      number,
      branch: `task/${key}`,
    });
  }
  return client;
}

export function stackFixturePlan(
  key: "left" | "right" = "left",
  parent: "root" | "left" | "right" = "root",
): ReturnType<typeof PrStacks.operation> {
  const numbers = { root: 6, left: 8, right: 9 };
  return {
    id: `operation-${key}`,
    sourceId: "source",
    repository: "owner/repo",
    assignment: key,
    launchId: key,
    previousOwners: [],
    number: numbers[key],
    branch: `task/${key}`,
    head: "head",
    base: "task/root",
    cut: "cut",
    remote: "origin",
    parents: [
      {
        assignment: parent,
        number: numbers[parent],
        branch: `task/${parent}`,
        head: "parent-head",
        base: "main",
      },
    ],
    target: "parent-head",
    targetBranch: `task/${parent}`,
    managed: false,
    retargetAttempted: false,
    pushAttempted: false,
    relayToMain: false,
    candidate: null,
    step: "planned",
    blocker: null,
    failures: [],
    attempts: [],
  };
}
