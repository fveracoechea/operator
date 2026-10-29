import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { ErrAsync, Ok, OkAsync, type Result } from "unthrown";
import { DeviceSettings } from "../device-settings/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { GithubApi } from "../github-api/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { answered, prAnswer, reviewHome, seedRequest, target } from "./home-fixture.ts";
import { acknowledge, ingest, readIntervalMs, slackActions } from "./slack.ts";

type Home = Awaited<ReturnType<typeof reviewHome>>;
let home: Home;
const now = Date.parse("2026-02-03T04:05:06.000Z");
const nowTs = "1770091506.000000";
const command = "operator review ingest --input <file>";
const policy = { channel: "C1", repos: ["example/one", "example/two"], authors: ["Author"] };

beforeEach(async () => {
  home = await reviewHome();
  setSystemTime(new Date(now));
});

afterEach(async () => {
  setSystemTime();
  mock.restore();
  await home.remove();
});

function one(number: number) {
  return `https://github.com/example/one/pull/${number}`;
}

function skew(seconds: number) {
  return `${1770091506 + seconds}.000000`;
}

/** A plain view of a result, so a test compares its whole value. */
function settled<T, E>(result: Result<T, E>) {
  return result.tag === "Ok"
    ? { tag: "Ok", value: result.value }
    : result.tag === "Err"
      ? { tag: "Err", error: result.error }
      : { tag: "Defect", cause: String(result.cause) };
}

/** The due channel read of the Slack actions. */
async function readOf(start: boolean) {
  const actions = await slackActions(home.paths, start);
  return actions.tag === "Ok" ? actions.value?.read : expect.unreachable("No Slack actions.");
}

function usePolicy(chosen: typeof policy | null = policy) {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(OkAsync(chosen));
}

function watchOf() {
  const read = DeviceState.readSlack(home.paths, "C1");
  return read.tag === "Ok" ? read.value.watch : expect.unreachable("Slack state was not read.");
}

function pending() {
  const read = DeviceState.readSlack(home.paths, "C1");
  return read.tag === "Ok" ? read.value.effects : expect.unreachable("Slack state was not read.");
}

/** Records the effects of PR #7's request in a Slack thread. */
function seedEffects(effects: { key: string; kind: string; content: string }[]) {
  seedRequest(home.paths, { slackChannel: "C1", slackTs: "1500.000001" });
  expect(DeviceState.changeReviewRequest(home.paths, target, () => Ok({ effects })).tag).toBe("Ok");
  return pending();
}

const header = "=== Message from Ana <ana@example.com> (U0ANA) at 2026-10-28 09:59:30 EDT === ";
function channelRead(messages: [string, string][], more = false) {
  return JSON.stringify({
    messages: `Channel: #reviews (C1)\n\n${messages
      .map(([ts, body]) => `${header}\nMessage TS: ${ts}\n${body}`)
      .join("\n\n")}`,
    pagination_info: more
      ? "There are more messages available. To view the next page, use cursor: `abc`\n"
      : "There are no more messages available.\n",
  });
}

/** Answers each PR read by its number. */
function github(pulls: Record<number, Record<string, unknown>>) {
  return spyOn(GithubApi, "call").mockImplementation(async (request) => {
    const number = Number(
      request.args.find((arg) => arg.startsWith("number="))?.slice("number=".length),
    );
    return answered(prAnswer(pulls[number] ?? {}));
  });
}

test("no channel means no Slack actions, and nothing is recorded", async () => {
  usePolicy(null);
  expect(settled(await slackActions(home.paths, true))).toEqual({ tag: "Ok", value: null });
});

test("before the first watch, a read is due with no cursor, and only the loop records one", async () => {
  usePolicy();
  expect(settled(await slackActions(home.paths, false))).toEqual({
    tag: "Ok",
    value: {
      channel: "C1",
      read: { tool: "slack_read_channel", params: { channel_id: "C1" }, command },
      nextReadAt: new Date(now).toISOString(),
      effects: [],
    },
  });
  expect(watchOf()).toBeNull();
  expect(await readOf(true)).toEqual({
    tool: "slack_read_channel",
    params: { channel_id: "C1", oldest: nowTs },
    command,
  });
  expect(watchOf()).toMatchObject({ cursor: nowTs, readAt: null, latest: null });
});

test("a Slack action read refuses a device with no state", async () => {
  usePolicy();
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${home.root}/empty`, NODE_ENV: "test" }),
  );
  expect(await slackActions(paths, false)).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
});

test("a read is due five minutes after the last ingest, and a paging read is due at once", async () => {
  usePolicy();
  DeviceState.startSlackWatch(home.paths, "C1", "1000.000000");
  const from = { cursor: "1000.000000", latest: null, pending: null };
  const ended = { cursor: "1200.000000", latest: null, pending: null, paging: false };
  const ingested = DeviceState.ingestSlack(home.paths, {
    channel: "C1",
    from,
    to: ended,
    candidates: [],
    start: [],
  });
  expect(ingested.tag).toBe("Ok");
  setSystemTime(new Date(now + readIntervalMs - 1));
  expect(await slackActions(home.paths, false)).toMatchObject({
    tag: "Ok",
    value: { read: null, nextReadAt: new Date(now + 5 * 60 * 1000).toISOString() },
  });
  setSystemTime(new Date(now + readIntervalMs));
  expect(await readOf(false)).toEqual({
    tool: "slack_read_channel",
    params: { channel_id: "C1", oldest: "1200.000000" },
    command,
  });
  DeviceState.ingestSlack(home.paths, {
    channel: "C1",
    from: { cursor: "1200.000000", latest: null, pending: null },
    to: { cursor: "1200.000000", latest: "1300.000000", pending: "1400.000000", paging: true },
    candidates: [],
    start: [],
  });
  expect(await readOf(false)).toEqual({
    tool: "slack_read_channel",
    params: { channel_id: "C1", oldest: "1200.000000", latest: "1300.000000" },
    command,
  });
});

test("each pending effect carries its exact MCP call and its acknowledgement command", async () => {
  usePolicy();
  const [reaction, reply] = seedEffects([
    { key: "reaction:eyes", kind: "reaction", content: "eyes" },
    { key: "reply:1", kind: "reply", content: "No blockers" },
  ]);
  await acknowledge({ paths: home.paths, id: reply?.id ?? "", text: '{"error":"no_access"}' });
  expect(await slackActions(home.paths, false)).toMatchObject({
    tag: "Ok",
    value: {
      effects: [
        {
          id: reaction?.id,
          kind: "reaction",
          url: target.url,
          tool: "slack_add_reaction",
          params: { channel_id: "C1", message_ts: "1500.000001", emoji: "eyes" },
          failure: null,
          command: `operator review slack-done ${reaction?.id} --input <file>`,
        },
        {
          id: reply?.id,
          kind: "reply",
          url: target.url,
          tool: "slack_send_message",
          params: { channel_id: "C1", thread_ts: "1500.000001", message: "No blockers" },
          failure: "no_access",
          command: `operator review slack-done ${reply?.id} --input <file>`,
        },
      ],
    },
  });
});

test("an ingest without a channel or with unknown input records nothing", async () => {
  usePolicy(null);
  expect(settled(await ingest({ paths: home.paths, text: channelRead([]) }))).toEqual({
    tag: "Err",
    error: {
      reason: "slack_not_configured",
      detail:
        "No Slack channel is set. Set review.channel, review.repos, and review.authors with operator config apply. Nothing was recorded.",
    },
  });
  mock.restore();
  usePolicy();
  expect(await ingest({ paths: home.paths, text: "not a read" })).toMatchObject({
    tag: "Err",
    error: { reason: "slack_input_unrecognized" },
  });
  expect(watchOf()).toBeNull();
});

test("an ingest records each eligible PR once and names why it ignores the others", async () => {
  usePolicy();
  github({
    7: { author: { login: "AUTHOR" } },
    8: { author: { login: "other" } },
    9: { state: "MERGED" },
    10: { author: null },
  });
  DeviceState.startSlackWatch(home.paths, "C1", "1000.000000");
  const text = channelRead([
    ["2001.000000", `${one(7)} ${"https://github.com/example/two/pull/3"} ${one(8)}`],
    ["2000.000001", `${one(7)} ${"https://github.com/example/zzz/pull/1"}`],
    ["900.000000", one(9)],
    ["2002.000000", `${one(9)} ${one(10)}`],
  ]);
  const ingested = await ingest({ paths: home.paths, text });
  expect(ingested).toMatchObject({
    tag: "Ok",
    value: {
      reason: "slack_ingested",
      data: {
        channel: "C1",
        cursor: { from: "1000.000000", to: "2002.000000" },
        paging: null,
        messages: 3,
        requests: [{ url: target.url, outcome: "recorded" }],
        ignored: [
          { url: "https://github.com/example/zzz/pull/1", reason: "repository_not_in_policy" },
          { url: "https://github.com/example/two/pull/3", reason: "repository_unregistered" },
          { url: one(8), reason: "author_not_in_policy" },
          { url: one(9), reason: "pr_not_open" },
          { url: one(10), reason: "author_not_in_policy" },
        ],
        slack: {
          channel: "C1",
          read: null,
          effects: [
            {
              kind: "reaction",
              url: target.url,
              params: { channel_id: "C1", message_ts: "2000.000001", emoji: "eyes" },
            },
          ],
        },
      },
    },
  });
  const data = ingested.tag === "Ok" ? ingested.value.data : expect.unreachable("No ingest.");
  const read = DeviceState.readReviewRequest(home.paths, target);
  expect(read).toMatchObject({
    tag: "Ok",
    value: { request: { slackChannel: "C1", slackTs: "2000.000001", origin: "slack" } },
  });
  expect(JSON.stringify(data)).toContain(
    read.tag === "Ok" ? (read.value.request?.id ?? "none") : "none",
  );
  expect(watchOf()).toMatchObject({ cursor: "2002.000000", latest: null, pending: null });
});

test("a first ingest starts at the ingest moment and allows one minute of clock skew", async () => {
  usePolicy();
  github({});
  const text = channelRead([
    [skew(60), target.url],
    [skew(61), "https://github.com/example/one/pull/8"],
  ]);
  expect(await ingest({ paths: home.paths, text })).toMatchObject({
    tag: "Ok",
    value: {
      data: {
        cursor: { from: nowTs, to: skew(60) },
        messages: 1,
        requests: [{ url: target.url, outcome: "recorded" }],
        ignored: [],
      },
    },
  });
});

test("a paged read keeps the cursor and asks for the older messages at once", async () => {
  usePolicy();
  github({});
  DeviceState.startSlackWatch(home.paths, "C1", "1000.000000");
  const text = channelRead(
    [
      ["3000.000000", "no link"],
      ["2500.000000", "no link"],
    ],
    true,
  );
  expect(await ingest({ paths: home.paths, text })).toMatchObject({
    tag: "Ok",
    value: {
      reason: "slack_ingested_page",
      data: {
        cursor: { from: "1000.000000", to: "1000.000000" },
        paging: { latest: "2500.000000" },
        messages: 2,
        requests: [],
        slack: {
          read: {
            params: { channel_id: "C1", oldest: "1000.000000", latest: "2500.000000" },
          },
        },
      },
    },
  });
  expect(watchOf()).toMatchObject({
    cursor: "1000.000000",
    latest: "2500.000000",
    pending: "3000.000000",
  });
  const last = channelRead([
    ["3000.000000", "no link"],
    ["2000.000000", target.url],
  ]);
  expect(await ingest({ paths: home.paths, text: last })).toMatchObject({
    tag: "Ok",
    value: {
      reason: "slack_ingested",
      data: {
        cursor: { from: "1000.000000", to: "3000.000000" },
        paging: null,
        messages: 1,
        requests: [{ url: target.url, outcome: "recorded" }],
        slack: { read: null },
      },
    },
  });
  expect(watchOf()).toMatchObject({ cursor: "3000.000000", latest: null, pending: null });
});

test("a failed GitHub read stops the ingest, so the cursor stays and nothing is recorded", async () => {
  usePolicy();
  spyOn(GithubApi, "call").mockResolvedValue({
    status: "failed",
    code: "HTTP 502",
    detail: "bad gateway",
    httpStatus: 502,
  });
  DeviceState.startSlackWatch(home.paths, "C1", "1000.000000");
  expect(
    await ingest({ paths: home.paths, text: channelRead([["2000.000000", target.url]]) }),
  ).toMatchObject({ tag: "Err", error: { reason: "github_failed" } });
  expect(watchOf()).toMatchObject({ cursor: "1000.000000", readAt: null });
  expect(settled(DeviceState.readReviewRequests(home.paths))).toEqual({ tag: "Ok", value: [] });
});

test("a policy read failure stops the ingest", async () => {
  spyOn(DeviceSettings, "slackReviewPolicy").mockReturnValue(
    ErrAsync({ reason: "invalid_settings" as const, detail: "broken" }),
  );
  expect(await ingest({ paths: home.paths, text: channelRead([]) })).toMatchObject({
    tag: "Err",
    error: { reason: "invalid_settings" },
  });
});

function sentReply(threadTs: string) {
  return JSON.stringify({
    message_link: `https://example.slack.com/archives/C1/p1?thread_ts=${threadTs}&cid=C1`,
    message_context: { message_ts: "1600.000002", channel_id: "C1" },
  });
}

test("a send result that shows the reply marks it done once", async () => {
  const [reply] = seedEffects([{ key: "reply:1", kind: "reply", content: "text" }]);
  const id = reply?.id ?? "";
  const done = {
    id,
    kind: "reply",
    state: "done",
    channel: "C1",
    threadTs: "1500.000001",
    slackTs: "1600.000002",
  };
  expect(
    settled(await acknowledge({ paths: home.paths, id, text: sentReply("1500.000001") })),
  ).toEqual({
    tag: "Ok",
    value: { reason: "slack_effect_done", data: done },
  });
  expect(settled(await acknowledge({ paths: home.paths, id, text: "{}" }))).toEqual({
    tag: "Ok",
    value: { reason: "slack_effect_unchanged", data: done },
  });
  expect(pending()).toEqual([]);
});

test("a reaction result proves only the same reaction", async () => {
  const [reaction] = seedEffects([{ key: "reaction:eyes", kind: "reaction", content: "eyes" }]);
  const id = reaction?.id ?? "";
  const text = JSON.stringify({ result: "Successfully added :eyes: reaction to the message." });
  expect(await acknowledge({ paths: home.paths, id, text })).toMatchObject({
    tag: "Ok",
    value: { reason: "slack_effect_done", data: { kind: "reaction", slackTs: null } },
  });
});

test("a refused send stays pending with its failure", async () => {
  const [reply] = seedEffects([{ key: "reply:1", kind: "reply", content: "text" }]);
  const id = reply?.id ?? "";
  expect(
    settled(
      await acknowledge({
        paths: home.paths,
        id,
        text: JSON.stringify({ error: "not_in_channel" }),
      }),
    ),
  ).toEqual({
    tag: "Err",
    error: {
      reason: "slack_effect_failed",
      detail:
        "Slack refused the reply: not_in_channel The effect stays pending, and the next wait gives it again.",
    },
  });
  expect(pending()).toMatchObject([{ id, state: "pending", failure: "not_in_channel" }]);
});

test("an unknown result stays pending and names what it lacks", async () => {
  const [reaction, reply] = seedEffects([
    { key: "reaction:eyes", kind: "reaction", content: "eyes" },
    { key: "reply:1", kind: "reply", content: "text" },
  ]);
  const id = reaction?.id ?? "";
  const detail = "The send result shows no success for this reaction: {}";
  expect(settled(await acknowledge({ paths: home.paths, id, text: "{}" }))).toEqual({
    tag: "Err",
    error: {
      reason: "slack_ack_unrecognized",
      detail: `The result does not show that Slack took the reaction: ${detail} The effect stays pending, and the next wait gives it again.`,
    },
  });
  expect(pending()).toMatchObject([{ id, state: "pending", failure: detail }, { failure: null }]);
  // A reply result for another thread proves nothing for this reply either.
  expect(
    await acknowledge({ paths: home.paths, id: reply?.id ?? "", text: sentReply("1.000001") }),
  ).toMatchObject({ tag: "Err", error: { reason: "slack_ack_unrecognized" } });
});

test("an unknown effect id is refused", async () => {
  expect(await acknowledge({ paths: home.paths, id: "none", text: "{}" })).toMatchObject({
    tag: "Err",
    error: { reason: "slack_effect_missing" },
  });
});
