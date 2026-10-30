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

async function setup() {
  device = await reviewDevice();
  return device;
}

const launchSchema = z.object({
  data: z.object({
    launch: z.object({ name: z.string(), worktreePath: z.string(), brief: z.string() }),
  }),
});

async function started(current: Device) {
  const request = await current.add();
  const start = await current.run(["review", "start", url]);
  expect(start.code, start.stderr).toBe(0);
  return { request, launch: launchSchema.parse(start.output).data.launch };
}

function paneCloses(calls: string[][]) {
  return calls.filter((call) => call.slice(0, 2).join(" ") === "pane close");
}

test("an approval releases the reviewer, and a renewed request gets a replacement with the earlier rounds", async () => {
  const current = await setup();
  const { request, launch } = await started(current);
  await current.draft(request.draft, current.head);
  expect(await current.run(["review", "post", url])).toMatchObject({
    code: 0,
    output: {
      reason: "review_posted",
      data: { state: "approved", event: "APPROVE", cleanup: { state: "done" } },
    },
  });
  expect(paneCloses(await current.herdrCalls())).toHaveLength(1);
  expect(await stat(launch.worktreePath).catch(() => null)).toBeNull();
  expect(await current.git(current.checkout, "branch", "--list", "review/*")).toBe("");
  // The request record stays, so a renewed request can reopen it.
  expect(await current.next()).toMatchObject([
    {
      state: "approved",
      wait: "review_approved",
      reviewer: { state: "interrupted", worktreePath: null, branch: null },
      cleanup: { state: "done" },
    },
  ]);
  expect(await current.run(["review", "cleanup", url])).toMatchObject({
    code: 3,
    output: { reason: "review_cleanup_unchanged" },
  });

  // An approved request ignores new commits, and a renewed request reopens it.
  const before = (await current.prompts()).length;
  const moved = await current.push(current.head, "later.ts");
  expect(await current.run(["review", "wait", "--timeout", "1"])).toMatchObject({
    output: { reason: "review_wait_timed_out" },
  });
  await current.pullRequest({
    reviewRequests: [{ reviewer: "owner", createdAt: new Date().toISOString() }],
  });
  const waited = await current.run(["review", "wait", "--timeout", "1"]);
  expect(waited).toMatchObject({
    code: 0,
    output: {
      data: {
        events: [{ kind: "round_started", trigger: "re-request" }],
        requests: [
          {
            state: "reviewing",
            action: "replace_reviewer",
            command: `operator review start ${url}`,
          },
        ],
      },
    },
  });
  // No prompt goes to the released reviewer.
  expect(await current.prompts()).toHaveLength(before);

  const replaced = await current.run(["review", "start", url]);
  expect(replaced).toMatchObject({
    code: 0,
    output: { reason: "reviewer_replaced", data: { state: "reviewing" } },
  });
  const replacement = launchSchema.parse(replaced.output).data.launch;
  expect(replacement.name).not.toBe(launch.name);
  // The PR moved while it was approved, so the replacement starts at the new head.
  expect(await current.git(replacement.worktreePath, "rev-parse", "HEAD")).toBe(moved);
  const brief = await Bun.file(replacement.brief).text();
  expect(brief).toContain("This is round 2, for a renewed review request.");
  const history = `${request.brief.replace(/brief\.md$/, "")}rounds/1.json`;
  expect(brief).toContain(`Draft: \`${history}\``);
  expect(await Bun.file(history).json()).toMatchObject({ reviewedCommit: current.head });
  // The cleanup of the released reviewer does not describe the replacement.
  expect(await current.next()).toMatchObject([
    { state: "reviewing", reviewer: { state: "running" }, cleanup: null },
  ]);
}, 60000);

test("an approval keeps unlanded reviewer work until the person removes it and cleans up", async () => {
  const current = await setup();
  const { request, launch } = await started(current);
  await Bun.write(`${launch.worktreePath}/notes.txt`, "unlanded\n");
  await current.draft(request.draft, current.head);
  expect(await current.run(["review", "post", url])).toMatchObject({
    code: 0,
    output: { data: { state: "approved", cleanup: { state: "kept" } } },
  });
  expect(await Bun.file(`${launch.worktreePath}/notes.txt`).text()).toBe("unlanded\n");
  expect(await current.next()).toMatchObject([
    { state: "approved", attention: "reviewer_work_kept", cleanup: { state: "kept" } },
  ]);

  await rm(`${launch.worktreePath}/notes.txt`);
  expect(await current.run(["review", "cleanup", url])).toMatchObject({
    code: 0,
    output: { reason: "reviewer_cleaned", data: { cleanup: { state: "done" } } },
  });
  expect(await stat(launch.worktreePath).catch(() => null)).toBeNull();
  expect(await current.git(current.checkout, "branch", "--list", "review/*")).toBe("");
  expect(await current.next()).toMatchObject([{ state: "approved", wait: "review_approved" }]);
}, 60000);

test("a cleanup releases the reviewer of a request that an earlier release approved", async () => {
  const current = await setup();
  const { launch } = await started(current);
  // An earlier release kept the reviewer of an approved request and recorded no cleanup.
  current.sql("UPDATE review_requests SET state = 'approved'");
  expect(await current.next()).toMatchObject([
    { state: "approved", wait: "review_approved", cleanup: null },
  ]);
  expect(await current.run(["review", "cleanup", url])).toMatchObject({
    code: 0,
    output: { reason: "reviewer_cleaned", data: { cleanup: { state: "done" } } },
  });
  expect(paneCloses(await current.herdrCalls())).toHaveLength(1);
  expect(await stat(launch.worktreePath).catch(() => null)).toBeNull();
  expect(await current.git(current.checkout, "branch", "--list", "review/*")).toBe("");
  expect(await current.run(["review", "cleanup", url])).toMatchObject({
    code: 3,
    output: { reason: "review_cleanup_unchanged" },
  });
}, 60000);
