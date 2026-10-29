import { afterEach, expect, test } from "bun:test";
// Bun has no recursive removal or directory existence API.
import { rm, stat } from "node:fs/promises";
import { z } from "zod";
import { reviewDevice, url } from "./review-fixture.ts";

type Device = Awaited<ReturnType<typeof reviewDevice>>;
let device: Device | null = null;

afterEach(async () => {
  if (device !== null) await rm(device.root, { recursive: true, force: true });
  device = null;
});

async function setup(host: "opencode" | "claude-code" = "opencode") {
  device = await reviewDevice(host);
  return device;
}

const launchSchema = z.object({
  data: z.object({
    launch: z.object({ name: z.string(), worktreePath: z.string(), brief: z.string() }),
  }),
});
const waitSchema = z.object({
  reason: z.string(),
  data: z.object({
    events: z.array(z.looseObject({ kind: z.string() })),
    requests: z.array(z.looseObject({})),
  }),
});
const blocker = { short: "Guard has no test", detail: "Add a test for the new guard." };

/** A started reviewer whose first round posted a comment, so the request watches the PR. */
async function watching(current: Device) {
  const request = await current.add();
  const started = await current.run(["review", "start", url]);
  expect(started.code, started.stderr).toBe(0);
  const launch = launchSchema.parse(started.output).data.launch;
  await current.draft(request.draft, current.head, { blockers: [blocker] });
  expect(await current.run(["review", "post", url])).toMatchObject({
    code: 0,
    output: { data: { state: "watching", event: "COMMENT" } },
  });
  return { request, launch };
}

async function wait(current: Device) {
  const waited = await current.run(["review", "wait", "--timeout", "1"]);
  expect(waited.code, waited.stderr).toBe(0);
  return waitSchema.parse(waited.output);
}

function now() {
  return new Date().toISOString();
}

for (const host of ["opencode", "claude-code"] as const)
  test(`${host}: every round trigger starts a round with the same reviewer and worktree`, async () => {
    const current = await setup(host);
    const { request, launch } = await watching(current);
    expect(await wait(current)).toMatchObject({
      reason: "review_wait_timed_out",
      data: { events: [] },
    });

    // An author reply in a review thread of the posting account.
    await current.pullRequest({
      threads: [
        {
          id: "T1",
          comments: [
            { id: "c1", author: "owner", body: "Add a test.", createdAt: "2000-01-01T00:00:00Z" },
            { id: "c2", author: "author", body: "The guard is covered.", createdAt: now() },
          ],
        },
      ],
    });
    expect(await wait(current)).toMatchObject({
      reason: "review_events_observed",
      data: {
        events: [{ kind: "round_started", trigger: "reply", reviewer: { kind: "round" } }],
        requests: [
          { state: "reviewing", wait: "review_draft", round: { number: 2, trigger: "reply" } },
        ],
      },
    });
    expect((await current.prompts()).at(-1)).toContain(
      "Review round 2 of PR #7 started, because of an author reply.",
    );
    await current.draft(request.draft, current.head, {
      threadReplies: [{ threadId: "T1", kind: "acknowledge", body: "Your reason holds." }],
    });
    expect(await current.run(["review", "post", url])).toMatchObject({
      code: 0,
      output: { data: { state: "approved", event: "APPROVE", review: { round: 2 } } },
    });
    expect(await wait(current)).toMatchObject({ reason: "review_wait_timed_out" });

    // An approved request ignores new commits, and a renewed request reopens it.
    const moved = await current.push(current.head, "later.ts");
    expect(await wait(current)).toMatchObject({ reason: "review_wait_timed_out" });
    await current.pullRequest({ reviewRequests: [{ reviewer: "owner", createdAt: now() }] });
    expect(await wait(current)).toMatchObject({
      data: { events: [{ kind: "round_started", trigger: "re-request" }] },
    });
    // The PR moved while it was approved, so the round also moves the worktree.
    expect((await current.prompts()).at(-1)).toContain(
      `because of a renewed review request. PR #7 moved from ${current.head} to ${moved} by a fast-forward.`,
    );
    expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(moved);
    // A post moved the last draft away, so a new round cannot post it again.
    expect(await Bun.file(request.draft).exists()).toBe(false);
    expect(await current.run(["review", "post", url])).toMatchObject({
      code: 3,
      output: { reason: "review_draft_missing" },
    });
    await current.draft(request.draft, moved, { blockers: [blocker] });
    expect(await current.run(["review", "post", url])).toMatchObject({
      code: 0,
      output: { data: { state: "watching", event: "COMMENT", review: { round: 3 } } },
    });

    // A thread that the author resolved.
    await current.pullRequest({
      threads: [
        {
          id: "T1",
          resolved: true,
          resolvedBy: "author",
          comments: [
            { id: "c1", author: "owner", body: "Add a test.", createdAt: "2000-01-01T00:00:00Z" },
          ],
        },
      ],
    });
    expect(await wait(current)).toMatchObject({
      data: { events: [{ kind: "round_started", trigger: "resolved" }] },
    });
    await current.draft(request.draft, moved, { blockers: [blocker] });
    expect((await current.run(["review", "post", url])).code).toBe(0);

    // New commits by a fast-forward move the worktree and name only the new commits.
    const forward = await current.push(moved, "next.ts");
    expect(await wait(current)).toMatchObject({
      data: {
        events: [
          {
            kind: "round_started",
            trigger: "commits",
            reviewer: { kind: "head", mode: "fast-forward" },
          },
        ],
      },
    });
    expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(forward);
    expect((await current.prompts()).at(-1)).toContain(`git log ${moved}..${forward}`);

    // A renewed manual request of a watching request is a round too.
    await current.draft(request.draft, forward, { blockers: [blocker] });
    expect((await current.run(["review", "post", url])).code).toBe(0);
    expect(await current.run(["review", "add", url])).toMatchObject({
      code: 0,
      output: {
        reason: "review_round_started",
        data: { state: "reviewing", round: { trigger: "re-request" } },
      },
    });

    // One reviewer and one worktree served every round.
    const prompted = (await current.herdrCalls()).filter((call) => call[1] === "prompt");
    expect(new Set(prompted.map((call) => call[2]))).toEqual(new Set([launch.name]));
    expect(
      (await current.herdrCalls()).filter((call) => call.slice(0, 2).join(" ") === "agent start"),
    ).toHaveLength(1);
    expect((await current.next())[0]).toMatchObject({
      reviewer: { worktreePath: launch.worktreePath },
    });
  }, 120000);

test("a fast-forward moves the same reviewer, a force push starts over, and the fourth move posts at the last reviewed commit", async () => {
  const current = await setup();
  const request = await current.add();
  const started = await current.run(["review", "start", url]);
  const launch = launchSchema.parse(started.output).data.launch;
  const base = await current.git(current.checkout, "rev-parse", "main");

  // Move 1: a fast-forward found by the post. Nothing is posted.
  const first = await current.push(current.head, "one.ts");
  await current.draft(request.draft, current.head);
  expect(await current.run(["review", "post", url])).toMatchObject({
    code: 4,
    output: { reason: "review_head_moved" },
  });
  expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(first);
  expect((await current.prompts()).at(-1)).toContain(
    `moved from ${current.head} to ${first} by a fast-forward`,
  );

  // Move 2: a force push found by the wait resets the worktree and asks for a full review.
  const second = await current.push(base, "two.ts");
  expect(
    await (async () => (await current.run(["review", "wait", "--timeout", "1"])).output)(),
  ).toMatchObject({
    data: {
      events: [
        {
          kind: "head_moved",
          from: first,
          to: second,
          reviewer: { kind: "head", mode: "force-push" },
        },
      ],
    },
  });
  expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(second);
  expect((await current.prompts()).at(-1)).toContain("Review the PR again from the start");

  // Move 3: the last move that the reviewer gets.
  const third = await current.push(second, "three.ts");
  await current.draft(request.draft, second);
  expect((await current.run(["review", "post", url])).output).toMatchObject({
    reason: "review_head_moved",
  });
  expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(third);

  // Move 4: past the limit the reviewer keeps its head, and the post states the limit.
  const fourth = await current.push(third, "four.ts");
  const promptsBefore = (await current.prompts()).length;
  expect((await current.run(["review", "wait", "--timeout", "1"])).output).toMatchObject({
    reason: "review_wait_timed_out",
  });
  expect(await current.prompts()).toHaveLength(promptsBefore);
  await current.draft(request.draft, third);
  const posted = await current.run(["review", "post", url]);
  expect(posted).toMatchObject({
    code: 0,
    output: {
      data: {
        event: "APPROVE",
        headLimit: { reviewedCommit: third, head: fourth, moves: 3 },
        review: { commit: third, headLimit: { reviewedCommit: third, head: fourth, moves: 3 } },
      },
    },
  });
  const review = (await current.githubState()).posted?.at(-1);
  expect(review?.commit_id).toBe(third);
  expect(review?.body).toContain(`**Approved** · reviewed at ${third.slice(0, 7)}`);
  expect(review?.body).toContain(
    `The PR head moved 3 times during this review, so this review covers ${third}, not the current head ${fourth}.`,
  );
  expect((await current.githubState()).posted).toHaveLength(1);
}, 120000);

test("two simultaneous waits start one round and prompt the reviewer once", async () => {
  const current = await setup();
  await watching(current);
  const before = (await current.prompts()).length;
  await current.pullRequest({
    comments: [{ id: "p1", author: "author", body: "@owner please look again.", createdAt: now() }],
  });
  // Both waits read the request before either writes, so only the transaction guard decides.
  await current.github({ reviewReadDelayMs: 1500 });
  const results = await Promise.all([
    current.run(["review", "wait", "--timeout", "2"]),
    current.run(["review", "wait", "--timeout", "2"]),
  ]);
  const events = results.flatMap((result) => waitSchema.parse(result.output).data.events);
  expect(events.filter((event) => event.kind === "round_started")).toHaveLength(1);
  expect(await current.prompts()).toHaveLength(before + 1);
}, 60000);

test("a quiet watching request goes stale after seven days, and author activity clears the flag", async () => {
  const current = await setup();
  await watching(current);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  current.sql("UPDATE review_requests SET activity_at = ?", old);
  current.sql("UPDATE review_rounds SET posted_at = ?", old);
  // Two simultaneous waits that both read the request before either writes set the flag once.
  await current.github({ reviewReadDelayMs: 1500 });
  const results = await Promise.all([
    current.run(["review", "wait", "--timeout", "1"]),
    current.run(["review", "wait", "--timeout", "1"]),
  ]);
  const events = results.flatMap((result) => waitSchema.parse(result.output).data.events);
  expect(events.filter((event) => event.kind === "review_stale")).toHaveLength(1);
  await current.github({ reviewReadDelayMs: 0 });
  expect(await current.next()).toMatchObject([
    { state: "watching", stale: true, wait: "review_watching" },
  ]);
  // The flag is visible, not a state, and a second wait does not report it again.
  expect(await wait(current)).toMatchObject({
    reason: "review_wait_timed_out",
    data: { events: [] },
  });
  await current.pullRequest({
    comments: [{ id: "p1", author: "author", body: "@owner please look again.", createdAt: now() }],
  });
  expect(await wait(current)).toMatchObject({
    data: {
      events: [{ kind: "round_started", trigger: "reply" }],
      requests: [{ state: "reviewing", stale: false }],
    },
  });
}, 60000);

test("a replacement reviewer reuses the worktree and receives the earlier drafts", async () => {
  const current = await setup();
  const { request, launch } = await watching(current);
  const pane = z
    .object({ reviewer: z.object({ paneId: z.string() }) })
    .parse((await current.next())[0]).reviewer.paneId;
  await current.herdr("pane", "exit", pane, pane.split(":")[0] ?? "");
  // A watching request does not need its reviewer until a round starts.
  expect(await current.next()).toMatchObject([
    { state: "watching", reviewer: { state: "interrupted" }, wait: "review_watching" },
  ]);
  const before = (await current.prompts()).length;
  await current.pullRequest({
    comments: [{ id: "p1", author: "author", body: "@owner please look again.", createdAt: now() }],
  });
  expect(await wait(current)).toMatchObject({
    data: {
      events: [{ kind: "round_started", trigger: "reply" }],
      requests: [
        {
          state: "reviewing",
          action: "replace_reviewer",
          reason: "reviewer_interrupted",
          command: `operator review start ${url}`,
        },
      ],
    },
  });
  expect(await current.prompts()).toHaveLength(before);

  const replaced = await current.run(["review", "start", url]);
  expect(replaced).toMatchObject({
    code: 0,
    output: { reason: "reviewer_replaced", data: { state: "reviewing" } },
  });
  const replacement = launchSchema.parse(replaced.output).data.launch;
  expect(replacement.name).not.toBe(launch.name);
  expect(replacement.worktreePath).toBe(launch.worktreePath);
  const brief = await Bun.file(replacement.brief).text();
  expect(brief).toContain("This is round 2, for an author reply.");
  const history = `${request.brief.replace(/brief\.md$/, "")}rounds/1.json`;
  expect(brief).toContain(`Draft: \`${history}\``);
  expect(await Bun.file(history).json()).toMatchObject({
    reviewedCommit: current.head,
    blockers: [blocker],
  });
  await current.draft(request.draft, current.head);
  expect(await current.run(["review", "post", url])).toMatchObject({
    code: 0,
    output: { data: { state: "approved", review: { round: 2 } } },
  });
}, 60000);

test("thread outcomes post once, and a lost reply is found after a restart", async () => {
  const current = await setup();
  const { request } = await watching(current);
  const old = "2000-01-01T00:00:00Z";
  await current.pullRequest({
    threads: [
      // Valid pushback, a resolved thread whose defect remains, and a fixed thread.
      {
        id: "T1",
        comments: [
          { id: "a", author: "owner", body: "Add a test.", createdAt: old },
          { id: "b", author: "author", body: "It is covered.", createdAt: now() },
        ],
      },
      {
        id: "T2",
        resolved: true,
        resolvedBy: "author",
        comments: [{ id: "c", author: "owner", body: "Close the file.", createdAt: old }],
      },
      {
        id: "T3",
        resolved: true,
        resolvedBy: "author",
        comments: [{ id: "d", author: "owner", body: "Rename it.", createdAt: old }],
      },
    ],
  });
  expect(await wait(current)).toMatchObject({ data: { events: [{ kind: "round_started" }] } });
  await current.draft(request.draft, current.head, {
    threadReplies: [
      { threadId: "T1", kind: "acknowledge", body: "Your reason holds." },
      { threadId: "T2", kind: "explain", body: "The file still stays open on the error path." },
    ],
  });
  await current.github({ threadLost: true });
  expect(await current.run(["review", "post", url])).toMatchObject({
    code: 1,
    output: { reason: "github_uncertain" },
  });
  expect(await current.next()).toMatchObject([
    { state: "posting", action: "post_review", reason: "review_post_uncertain" },
  ]);
  expect(await current.run(["review", "post", url])).toMatchObject({
    code: 0,
    output: {
      data: {
        state: "watching",
        event: "COMMENT",
        threadOperations: [
          { threadId: "T1", kind: "reply", state: "done" },
          { threadId: "T2", kind: "reply", state: "done" },
          { threadId: "T2", kind: "unresolve", state: "done" },
        ],
      },
    },
  });
  const state = await current.githubState();
  // The lost reply landed once, and the retry found it by its marker.
  expect(state.threadCalls?.map((call) => `${call.kind} ${call.thread}`)).toEqual([
    "reply T1",
    "reply T2",
    "unresolve T2",
  ]);
  expect(state.posted).toHaveLength(2);
  const threads = z
    .array(z.looseObject({ id: z.string(), resolved: z.boolean().optional() }))
    .parse(state.pulls[0]?.threads);
  expect(threads.map((thread) => [thread.id, thread.resolved ?? false])).toEqual([
    ["T1", false],
    ["T2", false],
    ["T3", true],
  ]);
  // The reopened thread is not a new author resolution, so no round starts.
  expect(await wait(current)).toMatchObject({ reason: "review_wait_timed_out" });
}, 60000);

test("a merged PR ends the request and keeps unlanded reviewer work until the person removes it", async () => {
  const current = await setup();
  const { launch } = await watching(current);
  await Bun.write(`${launch.worktreePath}/notes.txt`, "unlanded\n");
  await current.pullRequest({ state: "MERGED" });
  expect(await wait(current)).toMatchObject({
    data: {
      events: [{ kind: "review_closed", prState: "MERGED", cleanup: { state: "kept" } }],
      requests: [{ state: "closed", attention: "reviewer_work_kept", cleanup: { state: "kept" } }],
    },
  });
  expect(await Bun.file(`${launch.worktreePath}/notes.txt`).text()).toBe("unlanded\n");
  // A row that waits for the person does not end later waits at once.
  const started = Date.now();
  expect(await current.run(["review", "wait", "--timeout", "2"])).toMatchObject({
    output: { reason: "review_wait_timed_out" },
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  expect(
    (await current.herdrCalls()).some((call) => call.slice(0, 2).join(" ") === "pane close"),
  ).toBe(true);

  await rm(`${launch.worktreePath}/notes.txt`);
  expect(await current.run(["review", "cleanup", url])).toMatchObject({
    code: 0,
    output: { reason: "reviewer_cleaned", data: { cleanup: { state: "done" } } },
  });
  expect(await stat(launch.worktreePath).catch(() => null)).toBeNull();
  expect(await current.git(current.checkout, "branch", "--list", "review/*")).toBe("");
  expect(await current.next()).toEqual([]);
  expect(await current.run(["review", "cleanup", url])).toMatchObject({
    code: 3,
    output: { reason: "review_cleanup_unchanged" },
  });
}, 60000);

test("a skip ends one PR's request and removes its reviewer, and a later request is new", async () => {
  const current = await setup();
  const request = await current.add();
  const launch = launchSchema.parse((await current.run(["review", "start", url])).output).data
    .launch;
  // An open request refuses a cleanup and changes nothing.
  const database = `${current.root}/state/operator/operator.sqlite`;
  const before = await Bun.file(database).arrayBuffer();
  expect(await current.run(["review", "cleanup", url])).toMatchObject({
    code: 4,
    output: { reason: "review_request_open" },
  });
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);

  expect(await current.run(["review", "skip", url])).toMatchObject({
    code: 0,
    output: { reason: "review_skipped", data: { state: "skipped", cleanup: { state: "done" } } },
  });
  expect(await stat(launch.worktreePath).catch(() => null)).toBeNull();
  expect(await current.git(current.checkout, "branch", "--list", "review/*")).toBe("");
  expect(await current.next()).toEqual([]);
  expect(await current.run(["review", "skip", url])).toMatchObject({
    code: 3,
    output: { reason: "review_request_missing" },
  });
  const again = await current.add();
  expect(again.id).not.toBe(request.id);
  expect(again).toMatchObject({ state: "queued", reviewer: null });
}, 60000);

test("a replacement of a watching reviewer keeps the reviewed head, so new commits still start a round", async () => {
  const current = await setup();
  const { launch } = await watching(current);
  const pane = z
    .object({ reviewer: z.object({ paneId: z.string() }) })
    .parse((await current.next())[0]).reviewer.paneId;
  await current.herdr("pane", "exit", pane, pane.split(":")[0] ?? "");
  const moved = await current.push(current.head, "later.ts");
  expect(await current.run(["review", "start", url])).toMatchObject({
    code: 0,
    output: { reason: "reviewer_replaced", data: { state: "watching", head: current.head } },
  });
  expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(current.head);
  expect(await wait(current)).toMatchObject({
    data: {
      events: [{ kind: "round_started", trigger: "commits", reviewer: { kind: "head" } }],
    },
  });
  expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(moved);
}, 60000);

test("a failed reviewer move is reported once, and a later wait finishes it after the person cleans up", async () => {
  const current = await setup();
  await current.add();
  const launch = launchSchema.parse((await current.run(["review", "start", url])).output).data
    .launch;
  await Bun.write(`${launch.worktreePath}/scratch.txt`, "scratch\n");
  const moved = await current.push(current.head, "one.ts");
  expect(await wait(current)).toMatchObject({
    data: {
      events: [
        {
          kind: "head_moved",
          reviewer: { kind: "failed", reason: "review_worktree_changed" },
        },
      ],
      requests: [{ action: "wait_reviews", reason: "reviewer_move_unfinished" }],
    },
  });
  // The same failure is not reported again, and the wait does not return for its own row.
  const started = Date.now();
  expect(await wait(current)).toMatchObject({
    reason: "review_wait_timed_out",
    data: { events: [] },
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(current.head);
  await rm(`${launch.worktreePath}/scratch.txt`);
  expect(await wait(current)).toMatchObject({
    data: {
      events: [{ kind: "reviewer_synced", reviewer: { kind: "head", mode: "fast-forward" } }],
      requests: [{ state: "reviewing", wait: "review_draft", reviewer: { failure: null } }],
    },
  });
  expect(await current.git(launch.worktreePath, "rev-parse", "HEAD")).toBe(moved);
}, 60000);

test("a renewed request that the next post answers does not reopen the request", async () => {
  const current = await setup();
  const { request } = await watching(current);
  const moved = await current.push(current.head, "one.ts");
  expect(await wait(current)).toMatchObject({
    data: { events: [{ kind: "round_started", trigger: "commits" }] },
  });
  // The author asks again while the reviewer works on the round.
  await Bun.sleep(20);
  await current.pullRequest({ reviewRequests: [{ reviewer: "owner", createdAt: now() }] });
  await Bun.sleep(20);
  await current.draft(request.draft, moved);
  expect((await current.run(["review", "post", url])).output).toMatchObject({
    data: { state: "approved" },
  });
  expect(await wait(current)).toMatchObject({ reason: "review_wait_timed_out" });
}, 60000);

test("only author comments that mention the posting account start a round", async () => {
  const current = await setup();
  await watching(current);
  await current.pullRequest({
    comments: [
      { id: "p1", author: "author", body: "/deploy", createdAt: now() },
      { id: "p2", author: "author", body: "Thanks @someone-else.", createdAt: now() },
    ],
  });
  expect(await wait(current)).toMatchObject({ reason: "review_wait_timed_out" });
  await current.pullRequest({
    comments: [{ id: "p3", author: "author", body: "@owner fixed, PTAL.", createdAt: now() }],
  });
  expect(await wait(current)).toMatchObject({
    data: { events: [{ kind: "round_started", trigger: "reply" }] },
  });
}, 60000);

test("a skip waits while a wait prompts the reviewer, and removes nothing", async () => {
  const current = await setup();
  const { launch } = await watching(current);
  await current.herdrState({ promptDelayMs: 5000 });
  await current.pullRequest({
    comments: [{ id: "p1", author: "author", body: "@owner done.", createdAt: now() }],
  });
  const waiting = current.run(["review", "wait", "--timeout", "1"]);
  await Bun.sleep(2500);
  expect(await current.run(["review", "skip", url])).toMatchObject({
    code: 4,
    output: { reason: "review_reviewer_moving" },
  });
  expect(await stat(launch.worktreePath)).not.toBeNull();
  expect(
    (await current.herdrCalls()).some((call) => call.slice(0, 2).join(" ") === "pane close"),
  ).toBe(false);
  expect((await waiting).output).toMatchObject({
    data: { events: [{ kind: "round_started", reviewer: { kind: "round" } }] },
  });
  await current.herdrState({ promptDelayMs: 0 });
  expect(await current.run(["review", "skip", url])).toMatchObject({
    code: 0,
    output: { reason: "review_skipped" },
  });
}, 60000);
