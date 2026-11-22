import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";

let root = "";
const shippedHistory = readMigrationFiles({
  migrationsFolder: Bun.fileURLToPath(new URL("../device-state/migrations/", import.meta.url)),
}).map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis }));
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test.each([false, true])(
  "a migrated parked owner with known historical head %s needs observed merge evidence before protected cleanup",
  async (known) => {
    const device = await workerDevice({ github: true });
    root = device.root;
    const source = await device.register({
      trackerKey: "historical-merge",
      assignments: [
        {
          key: "old",
          trackerKey: "old",
          kind: "implementation",
          instructions: "Keep the PR.",
          dependencies: [],
          branch: "task/old",
        },
      ],
    });
    const worktree = `${root}/old`;
    expect(
      (await device.exec(["git", "worktree", "add", "-b", "task/old", worktree], device.main)).code,
    ).toBe(0);
    const head = (await device.exec(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    db.exec(
      "DROP TABLE commit_deliveries; DROP TABLE delivery_validations; DROP TABLE deliveries; ALTER TABLE worker_questions DROP COLUMN awaiting_person_seen_at; DELETE FROM __drizzle_migrations WHERE created_at >= 1795125600000; UPDATE assignments SET state = 'pr-open', kind = NULL",
    );
    expect(db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all()).toEqual(
      shippedHistory.filter((migration) => migration.created_at < 1795125600000),
    );
    db.query(
      "INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, branch, host, model, requested_model, reasoning_effort, release, skills, started_at, ended_at, worktree_path, herdr_socket) VALUES ('historical', ?, 'old', 1, 'interrupted', 'historical', 'worktree', 'task/old', 'opencode', 'test/reasoner', 'test/reasoner', 'medium', '{\"version\":\"historical\"}', '[]', 'then', 'later', ?, ?)",
    ).run(source, worktree, `${root}/herdr.sock`);
    db.query(
      "INSERT INTO worktree_preparations (path, repository, state, detail, started_at, finished_at) VALUES (?, 'example/one', 'prepared', 'Synthetic preparation', 'then', 'later')",
    ).run(worktree);
    db.query(
      "INSERT INTO pull_requests (source_id, assignment, repository, number, url, branch, associated_at, progress, wait_state) VALUES (?, 'old', 'example/one', 7, 'https://github.com/example/one/pull/7', 'task/old', 'then', '{\"seen\":[],\"failures\":[],\"eligibleHead\":null}', 'idle')",
    ).run(source);
    db.query(
      "INSERT INTO internal_reviews (source_id, assignment, state, implementer_launch_id, handoff_state, started_at, updated_at, ready_head) VALUES (?, 'old', 'ready', 'historical', 'done', 'then', 'then', ?)",
    ).run(source, known ? head : null);
    const history = db.query("SELECT * FROM launches").all();
    const reviews = db.query("SELECT * FROM internal_reviews").all();
    expect((await device.run(["--version"])).code).toBe(0);
    expect(db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all()).toEqual(
      shippedHistory,
    );
    const readiness = db.query("SELECT readiness FROM pull_requests").get();
    expect(
      db.query("SELECT json_extract(parking, '$.head') AS head FROM pull_requests").get(),
    ).toEqual({ head: known ? head : null });
    db.exec("UPDATE parked_pr_reads SET last_read_at = NULL");
    const pull = {
      number: 7,
      url: "https://github.com/example/one/pull/7",
      headRefName: "task/old",
      headRepository: "example/one",
      state: "MERGED",
      head,
      mergeCommit: null as string | null,
    };
    function github() {
      return Bun.write(
        `${root}/github.json`,
        JSON.stringify({
          pulls: [pull],
          branches: { "task/old": head },
        }),
      );
    }
    await github();
    function observe() {
      return device.run(["next", "--source", source, "--wait", "--timeout", "0"]);
    }
    const observed = await observe();
    expect(observed.output.reason, JSON.stringify(observed)).toMatch(
      /^next_actions_changed$|^next_wait_timed_out$/,
    );
    expect(db.query("SELECT state FROM assignments").get()).toEqual({ state: "pr-open" });
    expect(db.query("SELECT * FROM cleanups").all()).toEqual([]);
    expect(await Bun.file(`${worktree}/package.json`).exists()).toBe(true);
    expect(
      db.query("SELECT json_extract(parking, '$.head') AS head FROM pull_requests").get(),
      JSON.stringify({ observed, reads: db.query("SELECT * FROM parked_pr_reads").all() }),
    ).toEqual({ head });
    expect(await Bun.file(`${root}/gh-calls.jsonl`).text()).not.toContain('"DELETE"');
    pull.mergeCommit = head;
    await github();
    db.exec("UPDATE parked_pr_reads SET last_read_at = NULL");
    const repeated = await observe();
    expect(repeated.output.reason, JSON.stringify(repeated)).toMatch(
      /^next_actions_changed$|^next_wait_timed_out$/,
    );
    expect(
      db.query("SELECT state FROM assignments").get(),
      JSON.stringify({
        observed,
        parking: db.query("SELECT parking FROM pull_requests").get(),
        gh: (await Bun.file(`${root}/gh-calls.jsonl`).exists())
          ? await Bun.file(`${root}/gh-calls.jsonl`).text()
          : "no calls",
      }),
    ).toEqual({ state: "merged" });
    expect(db.query("SELECT state FROM cleanups").all()).toEqual([{ state: "done" }]);
    expect(await Bun.file(`${worktree}/package.json`).exists()).toBe(false);
    expect(
      (await device.exec(["git", "show-ref", "--verify", "refs/heads/task/old"], device.main)).code,
    ).not.toBe(0);
    expect(db.query("SELECT * FROM launches").all()).toEqual(history);
    expect(db.query("SELECT * FROM internal_reviews").all()).toEqual(reviews);
    expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual([]);
    expect(db.query("SELECT readiness FROM pull_requests").get()).toEqual(readiness);
    expect(await Bun.file(`${root}/gh-calls.jsonl`).text()).not.toContain("merge-async");
    expect((await device.herdrCalls()).some((call) => call === "agent start")).toBe(false);
  },
  60000,
);
