import { afterEach, expect, test } from "bun:test";
// Bun has no recursive removal or permission API.
import { chmod, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { reviewDevice, url } from "./review-fixture.ts";

type Device = Awaited<ReturnType<typeof reviewDevice>>;
let device: Device | null = null;

afterEach(async () => {
  if (device !== null) await rm(device.root, { recursive: true, force: true });
  device = null;
});

const channel = "C0REVIEW";
const effectSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  url: z.string(),
  tool: z.string(),
  params: z.record(z.string(), z.string()),
  failure: z.string().nullable(),
});
type Effect = z.infer<typeof effectSchema>;
const slackSchema = z.object({
  channel: z.string(),
  read: z
    .object({
      tool: z.literal("slack_read_channel"),
      params: z.object({
        channel_id: z.string(),
        oldest: z.string().optional(),
        latest: z.string().optional(),
      }),
      command: z.string(),
    })
    .nullable(),
  effects: z.array(effectSchema),
});
const waitSchema = z.object({
  reason: z.string(),
  data: z.looseObject({ slack: slackSchema.nullable() }),
});
function pr(number: number) {
  return `https://github.com/example/one/pull/${number}`;
}

/** A device whose author policy watches one channel for PRs of `author` in example/one. */
async function setup(host: "opencode" | "claude-code") {
  device = await reviewDevice(host);
  const edits = [
    "--set",
    `review.channel=${channel}`,
    "--set",
    "review.repos=Example/One,example/two",
    "--set",
    "review.authors=Author",
  ];
  const planned = await device.run(["config", "plan", ...edits]);
  expect(planned.code, planned.stderr).toBe(0);
  const id = z.object({ data: z.object({ planId: z.string() }) }).parse(planned.output).data.planId;
  const configured = await device.run(["config", "apply", ...edits, "--plan", id]);
  expect(configured.code, configured.stderr).toBe(0);
  const state = await device.githubState();
  await device.github({
    pulls: [
      ...state.pulls,
      { number: 8, url: pr(8), state: "OPEN", author: "other", files: ["a.ts"] },
      { number: 9, url: pr(9), state: "CLOSED", author: "author", files: ["a.ts"] },
      { number: 10, url: pr(10), state: "OPEN", author: "author", files: ["a.ts"] },
      { number: 12, url: pr(12), state: "OPEN", author: "author", files: ["a.ts"] },
    ],
  });
  return device;
}

/** One pass of the Slack transport loop. */
async function wait(current: Device) {
  const waited = await current.run(["review", "wait", "--timeout", "0", "--slack"]);
  expect(waited.code, waited.stderr).toBe(0);
  return waitSchema.parse(waited.output);
}

async function slack(current: Device) {
  const next = await current.run(["review", "next"]);
  expect(next.code, next.stderr).toBe(0);
  return slackSchema.parse(
    z.object({ data: z.object({ slack: z.unknown() }) }).parse(next.output).data.slack,
  );
}

/** The raw result of `slack_read_channel` in the live form: JSON whose values are prose. */
async function channelRead(
  current: Device,
  messages: { ts: string; text: string }[],
  name = "read.json",
  hasMore = false,
) {
  const file = `${current.root}/${name}`;
  const prose = messages.map(
    (message) =>
      `=== Message from Ana <ana@example.com> (U0ANA) at 2026-10-28 09:59:30 EDT === \nMessage TS: ${message.ts}\n${message.text}`,
  );
  await Bun.write(
    file,
    JSON.stringify({
      messages: `Channel: #reviews (${channel})\n\n${prose.join("\n\n")}`,
      pagination_info: hasMore
        ? "There are more messages available. To view the next page, use cursor: `bmV4dA==`\n"
        : "There are no more messages available.\n",
    }),
  );
  return file;
}

async function ingest(current: Device, file: string) {
  return current.run(["review", "ingest", "--input", file]);
}

/** Reports the live success result of the tool call that the effect names. */
async function acknowledge(current: Device, effect: Effect | undefined) {
  const params = effect?.params ?? {};
  const result =
    effect?.tool === "slack_send_message"
      ? {
          message_link: `https://example.slack.com/archives/${params.channel_id}/p1792003999000200?thread_ts=${params.thread_ts}&cid=${params.channel_id}`,
          message_context: { message_ts: "1792003999.000200", channel_id: params.channel_id },
        }
      : { result: `Successfully added :${params.emoji}: reaction to the message.` };
  return acknowledgeText(current, effect?.id ?? "", JSON.stringify(result));
}

/** Reports the raw text of one send result. */
async function acknowledgeText(current: Device, id: string, text: string) {
  const file = `${current.root}/sent-${id}.json`;
  await Bun.write(file, text);
  return current.run(["review", "slack-done", id, "--input", file]);
}

function after(oldest: string, seconds: number) {
  return `${Number(oldest.split(".")[0]) + seconds}.000100`;
}

test("ingests a raw channel read through the author policy and continues from its cursor", async () => {
  const current = await setup("claude-code");
  const first = await wait(current);
  expect(first.reason).toBe("review_slack_ready");
  const read = first.data.slack?.read;
  expect(read).toMatchObject({
    tool: "slack_read_channel",
    params: { channel_id: channel },
    command: "operator review ingest --input <file>",
  });
  const oldest = read?.params.oldest ?? "";
  const m1 = after(oldest, 10);
  const m2 = after(oldest, 20);
  const m3 = after(oldest, 30);
  const file = await channelRead(current, [
    // Newest first, the way Slack answers.
    { ts: m3, text: `updated, see ${pr(10)}/files` },
    { ts: m2, text: `<${pr(8)}|other author> and <${pr(9)}|closed>` },
    {
      ts: m1,
      text: `please review <${pr(7)}> <https://github.com/example/two/pull/3> <https://github.com/other/repo/pull/1>`,
    },
    // At the cursor, so already read. PR #11 does not exist, so a read of it would fail.
    { ts: oldest, text: pr(11) },
  ]);
  const ingested = await ingest(current, file);
  expect(ingested.code, ingested.stderr).toBe(0);
  expect(ingested.output).toMatchObject({
    reason: "slack_ingested",
    data: {
      channel,
      cursor: { from: oldest, to: m3 },
      messages: 3,
      requests: [
        { url: pr(7), outcome: "recorded" },
        { url: pr(10), outcome: "recorded" },
      ],
      ignored: [
        { url: "https://github.com/example/two/pull/3", reason: "repository_unregistered" },
        { url: "https://github.com/other/repo/pull/1", reason: "repository_not_in_policy" },
        { url: pr(8), reason: "author_not_in_policy" },
        { url: pr(9), reason: "pr_not_open" },
      ],
    },
  });
  // Only eligible PRs get the start reaction, in the thread of the message that posted them.
  const effects = (await slack(current)).effects;
  expect(effects).toMatchObject([
    {
      kind: "reaction",
      url: pr(7),
      tool: "slack_add_reaction",
      params: { channel_id: channel, message_ts: m1, emoji: "eyes" },
    },
    {
      kind: "reaction",
      url: pr(10),
      tool: "slack_add_reaction",
      params: { channel_id: channel, message_ts: m3, emoji: "eyes" },
    },
  ]);
  expect(await current.next()).toMatchObject([
    { url: pr(7), state: "queued", action: "start_reviewer" },
    { url: pr(10), state: "queued", action: "start_reviewer" },
  ]);

  // The same read again records nothing and keeps the cursor.
  expect((await ingest(current, file)).output).toMatchObject({
    data: { cursor: { from: m3, to: m3 }, messages: 0, requests: [], ignored: [] },
  });
  expect((await slack(current)).effects).toHaveLength(2);
  expect((await slack(current)).read).toBeNull();

  // Each new process sees the same pending effects. An acknowledgement marks one done once.
  const [seven, tenEffect] = effects;
  const ten = tenEffect?.id ?? "";
  expect(await acknowledge(current, seven)).toMatchObject({
    code: 0,
    output: { reason: "slack_effect_done", data: { state: "done" } },
  });
  expect(await acknowledge(current, seven)).toMatchObject({
    code: 0,
    output: { reason: "slack_effect_unchanged" },
  });
  // A result that shows no success keeps the effect pending.
  expect(await acknowledgeText(current, ten, "Reaction added")).toMatchObject({
    code: 3,
    output: { reason: "slack_ack_unrecognized" },
  });
  // A refused send keeps the effect pending with its failure.
  expect(
    await acknowledgeText(current, ten, JSON.stringify({ error: "invalid_name" })),
  ).toMatchObject({
    code: 1,
    output: { reason: "slack_effect_failed" },
  });
  expect((await slack(current)).effects).toMatchObject([
    { id: ten, params: { emoji: "eyes" }, failure: "invalid_name" },
  ]);
  // A refused effect ends only the first pass of a wait, so waits do not spin on it.
  expect((await wait(current)).reason).toBe("review_slack_ready");
  // A repeated reaction succeeds with the same sentence.
  expect(await acknowledge(current, tenEffect)).toMatchObject({
    code: 0,
    output: { reason: "slack_effect_done" },
  });
  expect((await slack(current)).effects).toEqual([]);
  expect((await wait(current)).reason).toBe("review_actions_ready");

  // Five minutes after the ingest, the next read is due from the recorded cursor.
  current.sql("UPDATE slack_watches SET read_at = '2000-01-01T00:00:00.000Z'");
  expect((await wait(current)).data.slack?.read).toMatchObject({
    params: { channel_id: channel, oldest: m3 },
  });

  // A skip is for one PR. A new message with the skipped PR records nothing for it, and a new
  // PR of the same author is still eligible.
  expect((await current.run(["review", "skip", pr(10)])).code).toBe(0);
  const later = after(oldest, 40);
  const again = await ingest(
    current,
    await channelRead(current, [{ ts: later, text: `${pr(10)} ${pr(12)} ${pr(7)}` }], "later.json"),
  );
  expect(again.output).toMatchObject({
    data: {
      cursor: { from: m3, to: later },
      requests: [
        { url: pr(10), outcome: "skipped" },
        { url: pr(12), outcome: "recorded" },
        { url: pr(7), outcome: "open" },
      ],
    },
  });
  expect((await slack(current)).effects).toMatchObject([
    { url: pr(12), params: { message_ts: later, emoji: "eyes" } },
  ]);
}, 90000);

test("a host without Slack tools never waits on Slack, and next writes nothing", async () => {
  const current = await setup("opencode");
  // Before the first Slack loop, next shows a due read with no cursor and records none.
  // The tool takes no null, so the read names no oldest until the loop records the cursor.
  expect((await slack(current)).read?.params).toEqual({ channel_id: channel });
  function watches() {
    using db = new Database(`${current.root}/state/operator/operator.sqlite`, { readonly: true });
    return db.query("SELECT * FROM slack_watches").all();
  }
  expect(watches()).toEqual([]);
  const started = Date.now();
  const plain = await current.run(["review", "wait", "--timeout", "1"]);
  expect(plain).toMatchObject({
    code: 0,
    output: {
      reason: "review_wait_timed_out",
      data: { slack: { read: { params: { channel_id: channel } } } },
    },
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(watches()).toEqual([]);
}, 60000);

test("a refused ingest records nothing and keeps the cursor", async () => {
  const current = await setup("opencode");
  const oldest = (await wait(current)).data.slack?.read?.params.oldest ?? "";
  const text = `${current.root}/text.txt`;
  await Bun.write(
    text,
    "Messages in #reviews: please review https://github.com/example/one/pull/7",
  );
  expect(await ingest(current, text)).toMatchObject({
    code: 3,
    output: { reason: "slack_input_unrecognized" },
  });
  // A GitHub read that fails stops the ingest before any write.
  const missing = await channelRead(current, [
    { ts: after(oldest, 5), text: pr(7) },
    { ts: after(oldest, 6), text: pr(11) },
  ]);
  expect((await ingest(current, missing)).code).toBe(1);
  expect(await current.next()).toEqual([]);
  expect((await slack(current)).read).toMatchObject({ params: { oldest } });
  expect(
    await current.run(["review", "ingest", "--input", `${current.root}/absent.json`]),
  ).toMatchObject({ code: 3, output: { reason: "slack_input_missing" } });
  // A folder is not an input file. An unreadable file is a refusal, not a defect.
  expect(await current.run(["review", "ingest", "--input", current.root])).toMatchObject({
    code: 3,
    output: { reason: "slack_input_missing" },
  });
  const locked = `${current.root}/locked.json`;
  await Bun.write(locked, "{}");
  await chmod(locked, 0o000);
  expect(await current.run(["review", "ingest", "--input", locked])).toMatchObject({
    code: 1,
    output: { reason: "slack_input_unreadable" },
  });
}, 60000);

test("a paged channel read keeps the cursor until the older messages are read", async () => {
  const current = await setup("claude-code");
  const oldest = (await wait(current)).data.slack?.read?.params.oldest ?? "";
  const older = after(oldest, 10);
  const page = after(oldest, 20);
  const newest = after(oldest, 30);
  const first = await ingest(
    current,
    await channelRead(
      current,
      [
        { ts: newest, text: "chat" },
        { ts: page, text: pr(10) },
      ],
      "page.json",
      true,
    ),
  );
  expect(first.output).toMatchObject({
    reason: "slack_ingested_page",
    data: {
      cursor: { from: oldest, to: oldest },
      paging: { latest: page },
      requests: [{ url: pr(10) }],
    },
  });
  // The next read is due at once, for the messages before the page.
  expect((await wait(current)).data.slack?.read).toMatchObject({
    params: { channel_id: channel, oldest, latest: page },
  });
  const last = await ingest(
    current,
    await channelRead(current, [{ ts: older, text: pr(7) }], "older.json"),
  );
  expect(last.output).toMatchObject({
    reason: "slack_ingested",
    data: {
      cursor: { from: oldest, to: newest },
      paging: null,
      requests: [{ url: pr(7), outcome: "recorded" }],
    },
  });
  expect((await slack(current)).read).toBeNull();
}, 60000);

test("without a channel, review waits and next read no Slack and record no effects", async () => {
  for (const host of ["opencode", "claude-code"] as const) {
    device = await reviewDevice(host);
    expect(await wait(device)).toMatchObject({
      reason: "review_wait_timed_out",
      data: { slack: null },
    });
    const request = await device.add();
    expect((await device.run(["review", "start", url])).code).toBe(0);
    await device.draft(request.draft, device.head);
    expect((await device.run(["review", "post", url])).output).toMatchObject({
      data: { state: "approved", event: "APPROVE" },
    });
    expect(await device.run(["review", "ingest", "--input", "-"])).toMatchObject({
      code: 3,
      output: { reason: "slack_not_configured" },
    });
    expect(
      z
        .object({ data: z.object({ slack: z.null() }) })
        .parse((await device.run(["review", "next"])).output),
    ).toBeTruthy();
    await rm(device.root, { recursive: true, force: true });
    device = null;
  }
}, 120000);

const blockers = [
  { short: "Guard has no test", detail: "Add a test for the new guard." },
  { short: "Cursor moves before the write", detail: "Move the cursor in the same write." },
];

test("each posted round gets one reply and an additive reaction, with later-round progress", async () => {
  const current = await setup("claude-code");
  const oldest = (await wait(current)).data.slack?.read?.params.oldest ?? "";
  const ts = after(oldest, 3);
  await ingest(current, await channelRead(current, [{ ts, text: `review ${url}` }]));
  const [eyes] = (await slack(current)).effects;
  expect((await acknowledge(current, eyes)).code).toBe(0);
  const started = await current.run(["review", "start", url]);
  expect(started.code, started.stderr).toBe(0);
  const [request] = await current.next();
  const draft = z.object({ draft: z.string() }).parse(request).draft;

  // A lost GitHub answer records no Slack effect until the retry finds the review.
  await current.draft(draft, current.head, {
    blockers,
    niceToHaves: [{ short: "Name the cursor", detail: "Name the cursor after Slack." }],
  });
  await current.github({ postUncertain: true });
  expect((await current.run(["review", "post", url])).output.reason).toBe("github_uncertain");
  expect((await slack(current)).effects).toEqual([]);
  const posted = await current.run(["review", "post", url]);
  expect(posted.output).toMatchObject({ data: { state: "watching", event: "COMMENT" } });
  const reviewUrl = z
    .object({ data: z.object({ review: z.object({ url: z.string() }) }) })
    .parse(posted.output).data.review.url;
  const round1 = (await slack(current)).effects;
  expect(round1).toMatchObject([
    {
      kind: "reaction",
      tool: "slack_add_reaction",
      params: { channel_id: channel, message_ts: ts, emoji: "speech_balloon" },
    },
    {
      kind: "reply",
      tool: "slack_send_message",
      params: {
        channel_id: channel,
        thread_ts: ts,
        message: `Needs changes · 2 blockers, 1 nice to have · [review](${reviewUrl})\n• Guard has no test\n• Cursor moves before the write`,
      },
    },
  ]);
  for (const effect of round1) expect((await acknowledge(current, effect)).code).toBe(0);

  // Round 2 starts with new commits and approves.
  const moved = await current.push(current.head, "fixed.ts");
  expect((await wait(current)).data).toMatchObject({ events: [{ kind: "round_started" }] });
  await current.draft(draft, moved);
  const approved = await current.run(["review", "post", url]);
  expect(approved.output).toMatchObject({ data: { state: "approved", event: "APPROVE" } });
  const approvalUrl = z
    .object({ data: z.object({ review: z.object({ url: z.string() }) }) })
    .parse(approved.output).data.review.url;
  expect((await slack(current)).effects).toMatchObject([
    { kind: "reaction", params: { emoji: "white_check_mark" } },
    { kind: "reply", params: { message: `Approved · 2 of 2 fixed · [review](${approvalUrl})` } },
  ]);
}, 120000);
