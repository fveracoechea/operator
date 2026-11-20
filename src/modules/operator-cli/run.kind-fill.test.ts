import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";
import { z } from "zod";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("dispatch --kind fills a null kind and refuses when the kind is set", async () => {
  const device = await workerDevice();
  root = device.root;
  const source = await device.register({
    trackerKey: "fill",
    assignments: [
      {
        key: "read",
        trackerKey: "fill-read",
        kind: "research",
        instructions: "Read the facts.",
        dependencies: [],
      },
    ],
  });
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec("UPDATE assignments SET kind = NULL");
  const settings = await Bun.file(`${root}/config/operator/config.json`).text();
  const plan = db.query("SELECT plan FROM sources").get();
  expect(await device.next("read")).toMatchObject([
    {
      kind: null,
      next: { command: `operator dispatch --source ${source} --assignment read --kind <kind>` },
    },
  ]);
  expect(
    (await device.run(["dispatch", "--source", source, "--assignment", "read"])).output,
  ).toMatchObject({ reason: "assignment_kind_required", state: { kind: null } });
  const args = ["dispatch", "--source", source, "--assignment", "read", "--kind", "research"];
  const filled = await device.run(args);
  expect(filled.code, filled.stderr).toBe(0);
  expect(db.query("SELECT kind FROM assignments").get()).toEqual({ kind: "research" });
  expect((await device.run(args)).output).toMatchObject({
    reason: "assignment_kind_set",
    state: { kind: "research" },
  });
  expect(db.query("SELECT id FROM launches").all()).toHaveLength(1);
  expect(db.query("SELECT plan FROM sources").get()).toEqual(plan);
  expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe(settings);
});

test.each([
  ["implementation", "kind_completion_changed"],
  ["review", "kind_not_dispatchable"],
  ["pr-feedback", "kind_not_dispatchable"],
  ["general", "invalid_settings"],
])(
  "null fill with %s refuses without a kind, plan, settings, or launch write",
  async (kind, reason) => {
    const device = await workerDevice();
    root = device.root;
    const source = await device.register({
      trackerKey: "fill-refuse",
      assignments: [
        {
          key: "read",
          trackerKey: "read",
          kind: "research",
          instructions: "Read.",
          dependencies: [],
        },
      ],
    });
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    db.exec("UPDATE assignments SET kind = NULL");
    const before = db.serialize();
    const calls = await device.herdrCalls();
    const config = await Bun.file(`${root}/config/operator/config.json`).text();
    expect(
      (
        await device.run([
          "dispatch",
          "--source",
          source,
          "--assignment",
          "read",
          "--kind",
          kind ?? "",
        ])
      ).output,
    ).toMatchObject({ reason });
    expect(db.serialize()).toEqual(before);
    expect((await device.herdrCalls()).filter((call) => call !== "plugin list")).toEqual(
      calls.filter((call) => call !== "plugin list"),
    );
    expect(await Bun.file(`${root}/config/operator/config.json`).text()).toBe(config);
  },
);

test("racing null fills reserve exactly one kind and one worker launch", async () => {
  const device = await workerDevice();
  root = device.root;
  const source = await device.register({
    trackerKey: "fill-race",
    assignments: [
      {
        key: "read",
        trackerKey: "read",
        kind: "research",
        instructions: "Read.",
        dependencies: [],
      },
    ],
  });
  using db = new Database(`${root}/state/operator/operator.sqlite`);
  db.exec("UPDATE assignments SET kind = NULL");
  const outcomes = await Promise.all(
    ["research", "answer"].map((kind) =>
      device.run(["dispatch", "--source", source, "--assignment", "read", "--kind", kind]),
    ),
  );
  expect(outcomes.filter((outcome) => outcome.code === 0)).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome.output.reason === "assignment_kind_set"),
  ).toHaveLength(1);
  expect(db.query("SELECT id FROM launches").all()).toHaveLength(1);
});

test.each(["settings", "profile", "resources", "ownership"] as const)(
  "a null fill retains the existing %s refusal without a kind or launch write",
  async (failure) => {
    const device = await workerDevice();
    root = device.root;
    const source = await device.register({
      trackerKey: "fill-invalid",
      assignments: [
        {
          key: "read",
          trackerKey: "read",
          kind: "research",
          profile: "careful",
          instructions: "Read.",
          dependencies: [],
        },
      ],
    });
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    db.exec("UPDATE assignments SET kind = NULL");
    const config = `${root}/config/operator/config.json`;
    if (failure === "settings") await Bun.write(config, "{broken");
    if (failure === "profile")
      await Bun.write(
        config,
        JSON.stringify({ superAgent: { host: "opencode", model: "test/reasoner" } }),
      );
    if (failure === "resources")
      db.exec("UPDATE sources SET plan = json_set(plan, '$.assignments[0].resources', 'invalid')");
    if (failure === "ownership")
      db.exec(
        "UPDATE sources SET supervising_pane = 'owner:p0', supervising_session = 'different-session'",
      );
    const before = db.serialize();
    const settings = await Bun.file(config).text();
    const result = await device.run([
      "dispatch",
      "--source",
      source,
      "--assignment",
      "read",
      "--kind",
      "research",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.output.outcome).toBe("refused");
    const reasons = {
      settings: "invalid_settings",
      profile: "profile_missing",
      resources: "state_corrupt",
      ownership: "source_supervised_elsewhere",
    };
    expect(result.output.reason).toBe(reasons[failure]);
    expect(db.serialize()).toEqual(before);
    expect(db.query("SELECT id FROM launches").all()).toEqual([]);
    expect(await Bun.file(config).text()).toBe(settings);
  },
);

test.each([
  ["finished", "none"],
  ["failed", "none"],
  ["interrupted", "none"],
  ["finished", "ready"],
  ["failed", "ready"],
  ["interrupted", "ready"],
  ["finished", "skipped"],
  ["failed", "skipped"],
  ["interrupted", "skipped"],
] as const)(
  "migration-origin unknown-head parking resumes once from %s with %s review through observed feedback",
  async (historicalState, reviewState) => {
    const device = await workerDevice({ github: true });
    root = device.root;
    const source = await device.register({
      trackerKey: "old-pr",
      assignments: [
        {
          key: "old",
          trackerKey: "old",
          kind: "implementation",
          instructions: "Carry the recorded PR.",
          dependencies: [],
          branch: "task/old",
        },
      ],
    });
    const worktree = `${root}/old`;
    expect(
      (await device.exec(["git", "worktree", "add", "-b", "task/old", worktree], device.main)).code,
    ).toBe(0);
    using db = new Database(`${root}/state/operator/operator.sqlite`);
    db.exec(
      "ALTER TABLE worker_questions DROP COLUMN awaiting_person_seen_at; DELETE FROM __drizzle_migrations WHERE created_at >= 1795125600000; UPDATE assignments SET state = 'pr-open', kind = NULL",
    );
    db.query(
      "INSERT INTO launches (id, source_id, assignment, attempt, state, name, resources, branch, host, model, requested_model, reasoning_effort, release, skills, started_at, ended_at, worktree_path, herdr_socket) VALUES ('historical', ?, 'old', 1, 'interrupted', 'historical', 'worktree', 'task/old', 'opencode', 'test/reasoner', 'test/reasoner', 'medium', '{}', '[]', 'then', 'later', ?, ?)",
    ).run(source, worktree, `${root}/herdr.sock`);
    db.query(
      "INSERT INTO worktree_preparations (path, repository, state, detail, started_at, finished_at) VALUES (?, 'example/one', 'prepared', 'Synthetic prepared fixture', 'then', 'later')",
    ).run(worktree);
    db.query(
      "INSERT INTO pull_requests (source_id, assignment, repository, number, url, branch, associated_at, progress, wait_state) VALUES (?, 'old', 'example/one', 7, 'https://github.com/example/one/pull/7', 'task/old', 'then', '{\"seen\":[],\"failures\":[],\"eligibleHead\":null}', 'idle')",
    ).run(source);
    db.query("UPDATE launches SET state = ?, release = ?").run(
      historicalState,
      '{"version":"historical"}',
    );
    if (reviewState !== "none")
      db.query(
        "INSERT INTO internal_reviews (source_id, assignment, state, implementer_launch_id, handoff_state, started_at, updated_at) VALUES (?, 'old', ?, 'historical', 'done', 'then', 'then')",
      ).run(source, reviewState);
    const history = db.query("SELECT * FROM launches").get();
    const reviews = db.query("SELECT * FROM internal_reviews").all();
    const handoffs = db.query("SELECT * FROM kind_handoffs").all();
    expect((await device.run(["--version"])).code).toBe(0);
    expect(await device.next("old")).toMatchObject([{ action: "wait", reason: "pr_parked" }]);
    expect(
      (await device.run(["dispatch", "--source", source, "--assignment", "old"])).code,
    ).not.toBe(0);
    expect(db.query("SELECT id FROM launches").all()).toHaveLength(1);
    expect(
      db.query("SELECT json_extract(parking, '$.head') AS head FROM pull_requests").get(),
    ).toEqual({ head: null });
    const head = (await device.exec(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
    await Bun.write(
      `${root}/github.json`,
      JSON.stringify({
        pulls: [
          {
            number: 7,
            url: "https://github.com/example/one/pull/7",
            headRefName: "task/old",
            headRepository: "example/one",
            state: "OPEN",
            head,
            reviewDecision: "REVIEW_REQUIRED",
            checks: [{ name: "lint", conclusion: "SUCCESS" }],
            comments: [
              { id: "migration-feedback", author: "person", body: "Check this historical resume." },
            ],
          },
        ],
        branches: { "task/old": head },
      }),
    );
    expect(
      (await device.run(["next", "--source", source, "--wait", "--timeout", "0"])).output,
    ).toMatchObject({
      data: { sources: [{ actions: [{ action: "resume_pr_feedback" }] }] },
    });
    expect(
      db.query("SELECT json_extract(parking, '$.head') AS head FROM pull_requests").get(),
    ).toEqual({ head });
    const launched = await device.run(["dispatch", "--source", source, "--assignment", "old"]);
    expect(launched.code, launched.stderr).toBe(0);
    expect(launched.output).toMatchObject({
      data: { attempt: 2, kind: { name: "pr-feedback" }, worktreePath: worktree },
    });
    expect(db.query("SELECT * FROM launches WHERE id = 'historical'").get()).toEqual(history);
    expect(db.query("SELECT id FROM launches").all()).toHaveLength(2);
    const brief = z.object({ brief: z.string(), paneId: z.string() }).parse(launched.output.data);
    expect(await Bun.file(brief.brief).text()).toContain("Check this historical resume.");
    const merged = await device.run(["pr", "merge"], { cwd: worktree });
    expect(merged.output).toMatchObject({
      reason: "pr_merge_blocked",
      state: { conditions: { approved: false, reviewEnded: true } },
    });
    expect(await Bun.file(`${root}/gh-calls.jsonl`).text()).not.toContain("merge-async");
    expect(
      (await device.run(["dispatch", "--source", source, "--assignment", "old"])).code,
    ).not.toBe(0);
    expect((await device.event("pane.exited", { pane_id: brief.paneId })).code).toBe(0);
    const replacement = await device.run(["dispatch", "--source", source, "--assignment", "old"]);
    expect(replacement.code, replacement.stderr).toBe(0);
    expect(replacement.output).toMatchObject({
      data: { attempt: 3, kind: { name: "pr-feedback" }, worktreePath: worktree },
    });
    const replacementBrief = z.object({ brief: z.string() }).parse(replacement.output.data);
    expect(await Bun.file(replacementBrief.brief).text()).toContain(
      "Check this historical resume.",
    );
    expect(db.query("SELECT * FROM launches WHERE id = 'historical'").get()).toEqual(history);
    expect(db.query("SELECT * FROM internal_reviews").all()).toEqual(reviews);
    expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual(handoffs);
    expect(
      (await device.run(["dispatch", "--source", source, "--assignment", "old"])).code,
    ).not.toBe(0);
    expect(db.query("SELECT id FROM launches").all()).toHaveLength(3);
  },
);
