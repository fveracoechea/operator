import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { workerDevice } from "./worker-fixture.ts";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Environment } from "../environment/main.ts";
import { Ok } from "unthrown";

let device: Awaited<ReturnType<typeof workerDevice>>;
const branch = "feature/persons-work";
let head = "";
beforeEach(async () => {
  device = await workerDevice({ github: true });
  const remote = `${device.root}/remote.git`;
  async function git(...args: string[]) {
    const result = await device.exec(["git", ...args], device.main);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  await git("init", "-q", "--bare", "-b", "main", remote);
  await git("config", "url." + remote + ".insteadOf", "https://github.com/example/one.git");
  await git("remote", "add", "identity", "https://github.com/example/one");
  await git("checkout", "-q", "-b", branch);
  await git("commit", "-q", "--allow-empty", "-m", "person's work");
  await git("push", "-q", "origin", branch);
  head = await git("rev-parse", "HEAD");
  await git("checkout", "-q", "main");
  await git("branch", "-D", branch);
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({ viewer: "person", remote, pulls: [] }),
  );
}, 60000);
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
}, 60000);

test("one-off adoption of a branch uses the person's branch without new-work naming", async () => {
  const result = await device.run(
    ["dispatch", "--kind", "implementation", "--brief", "-", "--adopt", branch],
    { stdin: "Continue the existing work." },
  );
  expect(result.code, result.stderr).toBe(0);
  const data = z
    .object({ data: z.object({ branch: z.string(), worktreePath: z.string(), brief: z.string() }) })
    .parse(result.output).data;
  expect(data.branch).toBe(branch);
  const actual = await device.exec(["git", "rev-parse", "HEAD"], data.worktreePath);
  expect(actual.stdout.trim()).toBe(head);
  expect(await Bun.file(data.brief).text()).toContain(`Branch: \`${branch}\``);
  expect(await Bun.file(data.brief).text()).not.toContain("## Adopted PR");
}, 60000);

test.each([
  ["one-off", true, "implementation", "41"],
  ["one-off", true, "review", "https://github.com/example/one/pull/41"],
  ["one-off", false, "implementation", branch],
  ["one-off", false, "pr-feedback", "41"],
  ["plan", true, "implementation", "41"],
  ["plan", true, "review", "41"],
  ["plan", false, "implementation", "41"],
  ["plan", false, "pr-feedback", "41"],
] as const)(
  "%s adoption draft=%s enters %s",
  async (mode, draft, kind, selector) => {
    if (!draft) {
      const file = `${device.root}/config/operator/config.json`;
      const settings = z
        .looseObject({ review: z.looseObject({ internal: z.boolean() }) })
        .parse(await Bun.file(file).json());
      settings.review.internal = true;
      await Bun.write(file, JSON.stringify(settings));
    }
    await Bun.write(
      `${device.root}/github.json`,
      JSON.stringify({
        viewer: "person",
        pulls: [
          {
            number: 41,
            state: "OPEN",
            isDraft: draft,
            author: "person",
            headRefName: branch,
            head,
          },
        ],
      }),
    );
    let result;
    if (mode === "one-off") {
      result = await device.run(["dispatch", "--kind", kind, "--brief", "-", "--adopt", selector], {
        stdin: "Continue the PR.",
      });
    } else {
      const source = await device.register({
        trackerKey: "adopt-41",
        assignments: [
          {
            key: "existing",
            trackerKey: "issue-41",
            kind,
            instructions: "Continue the PR.",
            branch,
            adopt: 41,
            dependencies: [],
          },
        ],
      });
      result = await device.run(["dispatch", "--source", source, "--assignment", "existing"]);
    }
    expect(result.code, result.stderr).toBe(0);
    const data = z
      .object({ data: z.object({ sourceId: z.string(), branch: z.string(), brief: z.string() }) })
      .parse(result.output).data;
    expect(data.branch).toBe(branch);
    const brief = await Bun.file(data.brief).text();
    expect(brief).toContain(`Worker kind: \`${kind}\``);
    expect(brief).toContain("## Adopted PR");
    expect(brief).toContain(`Internal review: \`${kind === "review" ? "on" : "off"}\``);
    if (kind === "review") {
      const launch = z
        .object({ data: z.object({ paneId: z.string(), worktreePath: z.string() }) })
        .parse(result.output).data;
      const round = await device.run(["pr", "round", "--file", "-"], {
        cwd: launch.worktreePath,
        pane: launch.paneId,
        stdin: "## Findings\n",
      });
      expect(round.code, round.stderr).toBe(0);
    }
    if (!draft) {
      const shown = await device.run(["source", "show", "--source", data.sourceId]);
      expect(shown.output).toMatchObject({
        data: { pullRequests: [{ number: 41, readiness: { head } }] },
      });
      expect(brief).toContain(`Ready head: \`${head}\``);
    }
  },
  60000,
);

test.each([
  [true, "review"],
  [false, "pr-feedback"],
] as const)(
  "ended PR facts enter draft=%s %s without stale readiness",
  async (draft, kind) => {
    const github = {
      viewer: "person",
      pulls: [
        { number: 41, state: "OPEN", isDraft: true, author: "person", headRefName: branch, head },
      ],
    };
    await Bun.write(`${device.root}/github.json`, JSON.stringify(github));
    const source = await device.register({
      trackerKey: "old-plan",
      intent: "Keep the person's API.",
      assignments: [
        {
          key: "old-owner",
          kind: "review",
          trackerKey: "github:example/one#395",
          instructions: "Review the PR.",
          branch,
          adopt: 41,
          dependencies: [],
        },
      ],
    });
    const launch = await device.dispatch(source, "old-owner");
    const worktree = launch.worktreePath ?? "";
    const round = await device.run(["pr", "round", "--file", "-"], {
      cwd: worktree,
      pane: launch.paneId,
      stdin:
        "## Findings\n- blocker, Spec, src/api.ts: Preserve the API.\n- nice-to-have, Standards, src/api.ts: Rename the API.\n",
    });
    expect(round.code, round.stderr).toBe(0);
    const earlierNote = `${device.root}/earlier-note.md`;
    await Bun.write(earlierNote, "Do not inherit the earlier owner's authority or note.");
    // Seed the earlier owner's recorded ready summary. This fixture never grants the new owner readiness.
    {
      using db = new Database(`${device.root}/state/operator/operator.sqlite`);
      db.query(
        "UPDATE internal_reviews SET state = 'ready', ready_head = ?, comment_url = 'https://github.com/c/earlier', ended_at = '2026-11-19' WHERE source_id = ?",
      ).run(head, source);
      db.query("UPDATE pull_requests SET readiness = ? WHERE source_id = ?").run(
        JSON.stringify({
          head,
          at: "2026-11-19",
          note: earlierNote,
          dispositions: [
            { round: 1, finding: 1, disposition: "applied" },
            {
              round: 1,
              finding: 2,
              disposition: "declined",
              reason: "The person kept the public name.",
            },
          ],
        }),
        source,
      );
    }
    const ended = await device.run(["abandon", "--source", source, "--assignment", "old-owner"]);
    expect(ended.code, ended.stderr).toBe(0);
    expect((await device.exec(["git", "worktree", "remove", worktree], device.main)).code).toBe(0);
    for (const args of [
      ["checkout", "-q", branch],
      ["commit", "-q", "--allow-empty", "-m", "person's later work"],
      ["push", "-q", "origin", branch],
    ])
      expect((await device.exec(["git", ...args], device.main)).code).toBe(0);
    const incomingHead = (
      await device.exec(["git", "rev-parse", "HEAD"], device.main)
    ).stdout.trim();
    expect(incomingHead).not.toBe(head);
    expect((await device.exec(["git", "checkout", "-q", "main"], device.main)).code).toBe(0);
    github.pulls = github.pulls.map((pr) => ({ ...pr, isDraft: draft, head: incomingHead }));
    await Bun.write(`${device.root}/github.json`, JSON.stringify(github));
    const adopted = await device.run(
      ["dispatch", "--kind", kind, "--brief", "-", "--adopt", "41"],
      { stdin: "Continue the PR." },
    );
    expect(adopted.code, adopted.stderr).toBe(0);
    const incoming = z
      .object({ data: z.object({ brief: z.string(), sourceId: z.string() }) })
      .parse(adopted.output).data;
    const brief = incoming.brief;
    const text = await Bun.file(brief).text();
    expect(text).toContain("## Ended PR owner");
    expect(text).toContain(source);
    expect(text).toContain("> Keep the person's API.");
    expect(text).toContain("github:example/one#395");
    expect(text).toContain(`Round 1 at \`${head}\``);
    expect(text).toContain("> Preserve the API.");
    expect(text).toContain("> applied");
    expect(text).toContain("> declined: The person kept the public name.");
    expect(text).toContain("Summary: https://github.com/c/earlier");
    expect(text).not.toContain("Do not inherit the earlier owner's authority or note.");
    const current = z
      .object({
        data: z.object({
          launches: z.array(z.object({ state: z.string(), internalReview: z.boolean() })),
          pullRequests: z.array(z.object({ readiness: z.unknown() })),
          handoffs: z.array(z.unknown()),
          internalReviewRounds: z.array(z.unknown()),
        }),
      })
      .parse((await device.run(["source", "show", "--source", incoming.sourceId])).output).data;
    expect(current.launches).toMatchObject([{ state: "running", internalReview: draft }]);
    expect(current.pullRequests).toEqual([
      {
        readiness: draft
          ? null
          : { head: incomingHead, at: expect.any(String), note: null, dispositions: [] },
      },
    ]);
    expect(current.handoffs).toEqual([]);
    expect(current.internalReviewRounds).toEqual([]);
  },
  60000,
);

test("adopt refuses another author's PR and a PR a live assignment owns", async () => {
  const state = {
    viewer: "person",
    pulls: [
      { number: 41, state: "OPEN", isDraft: true, author: "other", headRefName: branch, head },
    ],
  };
  await Bun.write(`${device.root}/github.json`, JSON.stringify(state));
  const args = ["dispatch", "--kind", "implementation", "--brief", "-", "--adopt", "41"];
  const calls = await device.herdrCalls();
  expect((await device.run(args, { stdin: "Continue it." })).output).toMatchObject({
    reason: "adopt_pr_author_mismatch",
    state: { authorMatches: false },
  });
  expect(await device.herdrCalls()).toEqual(calls);
  state.pulls = state.pulls.map((pr) => ({ ...pr, author: "person" }));
  await Bun.write(`${device.root}/github.json`, JSON.stringify(state));
  expect((await device.run(args, { stdin: "Continue it." })).code).toBe(0);
  const before = await device.herdrCalls();
  expect((await device.run(args, { stdin: "Do not steal it." })).output).toMatchObject({
    reason: "adopt_assignment_owned",
  });
  expect(await device.herdrCalls()).toEqual(before);
}, 60000);

test("adopt refuses a PR or branch an open review request owns", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({
      HOME: `${device.root}/home`,
      XDG_CONFIG_HOME: `${device.root}/config`,
      XDG_STATE_HOME: `${device.root}/state`,
      NODE_ENV: "test",
    }),
  );
  const target = { repository: "example/one", number: 41 };
  expect(
    DeviceState.changeReviewRequest(paths, target, () =>
      Ok({
        insert: {
          id: "existing-review",
          ...target,
          url: "https://github.com/example/one/pull/41",
          origin: "manual",
          state: "queued",
        },
      }),
    ).tag,
  ).toBe("Ok");
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      viewer: "person",
      pulls: [
        { number: 41, state: "OPEN", isDraft: false, author: "person", headRefName: branch, head },
      ],
    }),
  );
  const calls = await device.herdrCalls();
  const args = ["dispatch", "--kind", "pr-feedback", "--brief", "-", "--adopt", "41"];
  expect((await device.run(args, { stdin: "Do not steal this review." })).output).toMatchObject({
    reason: "adopt_review_owned",
    state: { request: "existing-review" },
  });
  expect(DeviceState.changeReviewRequest(paths, target, () => Ok({ update: { branch } })).tag).toBe(
    "Ok",
  );
  await Bun.write(`${device.root}/github.json`, JSON.stringify({ pulls: [] }));
  expect(
    (
      await device.run(
        ["dispatch", "--kind", "implementation", "--brief", "-", "--adopt", branch],
        { stdin: "Do not take its branch." },
      )
    ).output,
  ).toMatchObject({ reason: "adopt_review_owned" });
  expect(await device.herdrCalls()).toEqual(calls);
}, 60000);

test.each(["diverged", "checked-out", "dirty"])(
  "branch-only adoption preserves %s work and names the person",
  async (state) => {
    const elsewhere = `${device.root}/occupied`;
    expect(
      (
        await device.exec(
          ["git", "worktree", "add", "-q", "-b", branch, elsewhere, `origin/${branch}`],
          device.main,
        )
      ).code,
    ).toBe(0);
    if (state === "dirty") await Bun.write(`${elsewhere}/persons-draft.md`, "Keep this draft.\n");
    if (state === "diverged") {
      expect(
        (
          await device.exec(
            ["git", "commit", "-q", "--allow-empty", "-m", "local-only work"],
            elsewhere,
          )
        ).code,
      ).toBe(0);
      expect((await device.exec(["git", "worktree", "remove", elsewhere], device.main)).code).toBe(
        0,
      );
    }
    const local = await device.exec(["git", "rev-parse", branch], device.main);
    const calls = await device.herdrCalls();
    const result = await device.run(
      ["dispatch", "--kind", "implementation", "--brief", "-", "--adopt", branch],
      { stdin: "Preserve the person's work." },
    );
    expect(result.output).toMatchObject({
      reason:
        state === "diverged"
          ? "adopt_branch_diverged"
          : state === "dirty"
            ? "adopt_branch_dirty"
            : "adopt_branch_checked_out",
      next: { decider: "person" },
    });
    expect((await device.exec(["git", "rev-parse", branch], device.main)).stdout).toBe(
      local.stdout,
    );
    const writes = new Set(["agent start", "worktree create", "tab create"]);
    expect((await device.herdrCalls()).filter((call) => writes.has(call))).toEqual(
      calls.filter((call) => writes.has(call)),
    );
    if (state === "dirty")
      expect(await Bun.file(`${elsewhere}/persons-draft.md`).text()).toBe("Keep this draft.\n");
  },
  60000,
);

test("ready adoption retains the association base guard before any launch", async () => {
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      viewer: "person",
      pulls: [
        {
          number: 41,
          state: "OPEN",
          isDraft: false,
          author: "person",
          headRefName: branch,
          head,
          baseRefName: "unplanned-base",
        },
      ],
    }),
  );
  const calls = await device.herdrCalls();
  const result = await device.run(
    ["dispatch", "--kind", "pr-feedback", "--brief", "-", "--adopt", "41"],
    { stdin: "Hold the unexpected base." },
  );
  expect(result.output).toMatchObject({
    reason: "adopt_pr_base_mismatch",
    state: { base: "unplanned-base", expected: "main" },
  });
  expect(await device.herdrCalls()).toEqual(calls);
}, 60000);

test("a directly adopted draft reviewer can finish ready and start a fresh feedback owner", async () => {
  await Bun.write(
    `${device.root}/github.json`,
    JSON.stringify({
      viewer: "person",
      pulls: [
        { number: 41, state: "OPEN", isDraft: true, author: "person", headRefName: branch, head },
      ],
    }),
  );
  const dispatched = await device.run(
    ["dispatch", "--kind", "review", "--brief", "-", "--adopt", "41"],
    { stdin: "Review this PR." },
  );
  expect(dispatched.code, dispatched.stderr).toBe(0);
  const launch = z
    .object({
      data: z.object({ sourceId: z.string(), paneId: z.string(), worktreePath: z.string() }),
    })
    .parse(dispatched.output).data;
  const round = await device.run(["pr", "round", "--file", "-"], {
    cwd: launch.worktreePath,
    pane: launch.paneId,
    stdin: "## Findings\n",
  });
  expect(round.code, round.stderr).toBe(0);
  const ready = await device.run(["pr", "ready", "--file", "-"], {
    cwd: launch.worktreePath,
    pane: launch.paneId,
    stdin: "## Overview\nThe diff matches the task.\n\n## Dispositions\n",
  });
  expect(ready.code, ready.stderr).toBe(0);
  const schema = z.object({
    data: z.object({
      launches: z.array(z.object({ state: z.string(), kind: z.object({ name: z.string() }) })),
      pullRequests: z.array(z.object({ readiness: z.object({ head: z.string() }) })),
    }),
  });
  let observed = schema.parse(
    (await device.run(["source", "show", "--source", launch.sourceId])).output,
  ).data;
  for (
    let attempt = 0;
    attempt < 100 &&
    !observed.launches.some((row) => row.kind.name === "pr-feedback" && row.state === "running");
    attempt++
  ) {
    await Bun.sleep(20);
    observed = schema.parse(
      (await device.run(["source", "show", "--source", launch.sourceId])).output,
    ).data;
  }
  expect(observed.launches).toMatchObject([
    { state: "finished", kind: { name: "review" } },
    { state: "running", kind: { name: "pr-feedback" } },
  ]);
  expect(observed.pullRequests).toMatchObject([{ readiness: { head } }]);
}, 60000);

test.each([
  ["prototype", true, "41", "invalid_source_plan"],
  ["answer", true, "41", "invalid_source_plan"],
  ["review", false, "41", "adopt_kind_invalid"],
  ["pr-feedback", true, "41", "adopt_kind_invalid"],
  ["review", true, branch, "adopt_kind_invalid"],
  [
    "implementation",
    true,
    "https://github.com/other/repository/pull/41",
    "adopt_repository_mismatch",
  ],
] as const)(
  "adopt refuses illegal %s entry draft=%s selector=%s",
  async (kind, draft, selector, reason) => {
    await Bun.write(
      `${device.root}/github.json`,
      JSON.stringify({
        viewer: "person",
        pulls:
          selector === branch
            ? []
            : [
                {
                  number: 41,
                  state: "OPEN",
                  isDraft: draft,
                  author: "person",
                  headRefName: branch,
                  head,
                },
              ],
      }),
    );
    const calls = await device.herdrCalls();
    expect(
      (
        await device.run(["dispatch", "--kind", kind, "--brief", "-", "--adopt", selector], {
          stdin: "Do not launch illegal work.",
        })
      ).output,
    ).toMatchObject({ reason });
    expect(await device.herdrCalls()).toEqual(calls);
    expect(
      (await device.exec(["git", "branch", "--list", branch], device.main)).stdout.trim(),
    ).toBe("");
  },
  60000,
);
