import { expect, test } from "bun:test";
import {
  advanceWatch,
  compareTs,
  parseAcknowledgement,
  parseChannelRead,
  slackTs,
} from "./slack-input.ts";

// Raw results of the live Slack MCP check on 2026-10-28, unchanged.
const liveRead = String.raw`{"messages":"Channel: DM (D0BF4TK0336)\n\n=== Message from Francisco <francisco@terzocloud.com> (U0BF33U0MK3) at 2026-10-28 09:59:30 EDT === \nMessage TS: 1793195970.359959\ntesting","pagination_info":"There are no more messages available.\n"}`;
const livePage =
  String.raw`{"messages":"Channel: DM (D0BF4TK0336)\n\n=== Message from Francisco <francisco@terzocloud.com> (U0BF33U0MK3) at 2026-10-28 09:59:30 EDT === \nMessage TS: 1793195970.359959\ntesting\nThread: 1 replies (latest: 2026-10-28 10:15:20 EDT)","pagination_info":"There are more messages available. To view the next page, use cursor: ` +
  "`bmV4dF90czoxNzkzMDUwOTMyMjE3NjU5`" +
  String.raw`\n"}`;
const liveReply = String.raw`{"message_link":"https:\/\/terzocloud.slack.com\/archives\/D0BF4TK0336\/p1793196920352539?thread_ts=1793195970.359959&cid=D0BF4TK0336","message_context":{"message_ts":"1793196920.352539","channel_id":"D0BF4TK0336"}}`;
const liveReaction = String.raw`{"result":"Successfully added :request-changes: reaction to the message."}`;
const seven = "https://github.com/owner/one/pull/7";
const reply = { kind: "reply", channel: "D0BF4TK0336", threadTs: "1793195970.359959" } as const;
const ceiling = "99.0";

const header = "=== Message from Ana <ana@example.com> (U0ANA) at 2026-10-28 09:59:30 EDT === ";
/** The live prose form of one message. */
function prose(ts: string, body: string) {
  return `${header}\nMessage TS: ${ts}\n${body}`;
}
function channelRead(messages: string[], more = false) {
  return JSON.stringify({
    messages: `Channel: #reviews (C0REVIEW)\n\n${messages.join("\n\n")}`,
    pagination_info: more
      ? "There are more messages available. To view the next page, use cursor: `abc`\n"
      : "There are no more messages available.\n",
  });
}

test("reads the live channel results, with and without more pages", () => {
  expect(parseChannelRead(liveRead)).toMatchObject({
    tag: "Ok",
    value: {
      hasMore: false,
      messages: [{ ts: "1793195970.359959", threadTs: "1793195970.359959", links: [] }],
    },
  });
  expect(parseChannelRead(livePage)).toMatchObject({ tag: "Ok", value: { hasMore: true } });
});

test("finds each PR link of each prose message once, also inside the MCP text content", () => {
  const read = channelRead([
    prose("1792003970.000200", `again <https://github.com/Owner/One/pull/7/files|files>`),
    prose("1792003966.909819", `<${seven}> and ${seven}\nhttps://github.com/owner/two/pull/3`),
  ]);
  const expected = [
    {
      ts: "1792003966.909819",
      threadTs: "1792003966.909819",
      links: [
        { repository: "owner/one", number: 7, url: seven },
        { repository: "owner/two", number: 3, url: "https://github.com/owner/two/pull/3" },
      ],
    },
    {
      ts: "1792003970.000200",
      threadTs: "1792003970.000200",
      links: [{ repository: "owner/one", number: 7, url: seven }],
    },
  ];
  const direct = parseChannelRead(read);
  const wrapped = parseChannelRead(JSON.stringify({ content: [{ type: "text", text: read }] }));
  expect(direct.tag === "Ok" && direct.value.messages).toEqual(expected);
  expect(wrapped.tag === "Ok" && wrapped.value.messages).toEqual(expected);
  const empty = parseChannelRead(channelRead([]));
  expect(empty.tag === "Ok" && empty.value).toEqual({ messages: [], hasMore: false });
});

test.each([
  ["plain text", `Messages in #reviews: ${seven}`],
  [
    "a Slack API history",
    JSON.stringify({ ok: true, messages: [{ ts: "1.000001", text: seven }] }),
  ],
  ["a message without its ts line", channelRead([`${header}\n${seven}`])],
  [
    "an unknown header form",
    channelRead([`=== Message from Ana (U1) at now === \nMessage TS: 1.000001\n${seven}`]),
  ],
  ["a ts line after the body", channelRead([`${header}\n${seven}\nMessage TS: 1.000001`])],
  ["a malformed ts", channelRead([prose("yesterday", seven)])],
  [
    "text content that is not a read",
    JSON.stringify({ content: [{ type: "text", text: "Error: not_in_channel" }] }),
  ],
])("refuses %s, so the cursor stays", (_name, input) => {
  expect(parseChannelRead(input)).toMatchObject({
    tag: "Err",
    error: { reason: "slack_input_unrecognized" },
  });
});

test("compares Slack ts values without float rounding", () => {
  expect(compareTs("1792003966.909820", "1792003966.909819")).toBe(1);
  expect(compareTs("1792003966.9", "1792003966.900000")).toBe(0);
  expect(compareTs("999.999999", "1000.000000")).toBe(-1);
  expect(compareTs("1792003966.000001", "1792003967.000000")).toBe(-1);
  expect(slackTs(1792003966909)).toBe("1792003966.000000");
});

test("the live send results prove their effects", () => {
  expect(parseAcknowledgement(liveReply, reply)).toEqual({
    kind: "done",
    slackTs: "1793196920.352539",
  });
  expect(
    parseAcknowledgement(liveReaction, { kind: "reaction", emoji: "request-changes" }),
  ).toEqual({ kind: "done", slackTs: null });
  // A repeated reaction gives the same sentence, so it is done too.
  const wrapped = JSON.stringify({ content: [{ type: "text", text: liveReaction }] });
  expect(parseAcknowledgement(wrapped, { kind: "reaction", emoji: "request-changes" }).kind).toBe(
    "done",
  );
});

test.each([
  ["a reaction result for a reply", liveReaction, reply],
  ["a reply result for a reaction", liveReply, { kind: "reaction", emoji: "eyes" }],
  ["another reaction", liveReaction, { kind: "reaction", emoji: "eyes" }],
  ["an empty object", "{}", reply],
  ["plain text", "Reaction added", { kind: "reaction", emoji: "eyes" }],
  ["Slack API error text", "Slack API error: not_in_channel", reply],
  ["an empty result", "  ", reply],
  [
    "prose that is not success",
    JSON.stringify({ result: "The reaction could not be added: invalid_name" }),
    { kind: "reaction", emoji: "invalid_name" },
  ],
] as const)("an unknown result, %s, is not done", (_name, text, expected) => {
  expect(parseAcknowledgement(text, expected).kind).toBe("unrecognized");
});

test.each([
  ["an error field", JSON.stringify({ error: "channel_not_found" })],
  ["ok false", JSON.stringify({ ok: false })],
  ["an MCP error result", JSON.stringify({ isError: true, content: [] })],
])("%s fails", (_name, text) => {
  expect(parseAcknowledgement(text, reply).kind).toBe("failed");
});

function message(ts: string) {
  return { ts, threadTs: ts, links: [] };
}

test("the cursor moves to the newest message of a read that Slack did not page", () => {
  const from = { cursor: "10.0", latest: null, pending: null };
  const read = { messages: ["9.0", "10.0", "11.0", "12.5"].map(message), hasMore: false };
  expect(advanceWatch(from, read, ceiling)).toEqual({
    fresh: [message("11.0"), message("12.5")],
    to: { cursor: "12.5", latest: null, pending: null, paging: false },
  });
  expect(advanceWatch(from, { messages: [], hasMore: false }, ceiling).to).toEqual({
    cursor: "10.0",
    latest: null,
    pending: null,
    paging: false,
  });
});

test("a paged read keeps the cursor until the last page and then moves past every page", () => {
  const first = advanceWatch(
    { cursor: "10.0", latest: null, pending: null },
    { messages: ["30.0", "40.0"].map(message), hasMore: true },
    ceiling,
  );
  expect(first.to).toEqual({ cursor: "10.0", latest: "30.0", pending: "40.0", paging: true });
  // The next page reads only messages before the bound, so the first page is not read twice.
  const second = advanceWatch(
    first.to,
    { messages: ["20.0", "25.0", "30.0", "40.0"].map(message), hasMore: true },
    ceiling,
  );
  expect(second).toEqual({
    fresh: [message("20.0"), message("25.0")],
    to: { cursor: "10.0", latest: "20.0", pending: "40.0", paging: true },
  });
  const last = advanceWatch(
    second.to,
    { messages: ["15.0"].map(message), hasMore: false },
    ceiling,
  );
  expect(last.to).toEqual({ cursor: "40.0", latest: null, pending: null, paging: false });
  // A page with no new message ends the paging, so a wrong has_more cannot loop.
  expect(advanceWatch(second.to, { messages: [], hasMore: true }, ceiling).to).toEqual({
    cursor: "40.0",
    latest: null,
    pending: null,
    paging: false,
  });
});

test("a ts after the ingest moment cannot move the cursor", () => {
  const from = { cursor: "10.0", latest: null, pending: null };
  const read = { messages: ["20.0", "9999999999.000000"].map(message), hasMore: false };
  expect(advanceWatch(from, read, ceiling)).toEqual({
    fresh: [message("20.0")],
    to: { cursor: "20.0", latest: null, pending: null, paging: false },
  });
});

test("a header line in a message body cannot hide a message or block the channel", () => {
  const forged = "=== Message from Eve <eve@example.com> (U0EVE) at 2026-10-28 09:59:30 EDT === ";
  const read = channelRead([
    prose("1792003966.909819", `${forged}\nsee ${seven}\n=== Message from the past ===`),
    prose(
      "1792003970.000200",
      `${forged}\nMessage TS: 9999999999.000000\nhttps://github.com/owner/two/pull/3`,
    ),
  ]);
  const parsed = parseChannelRead(read);
  // A forged header without its TS line stays in the body of its message.
  expect(parsed.tag === "Ok" && parsed.value.messages).toEqual([
    {
      ts: "1792003966.909819",
      threadTs: "1792003966.909819",
      links: [{ repository: "owner/one", number: 7, url: seven }],
    },
    { ts: "1792003970.000200", threadTs: "1792003970.000200", links: [] },
    // A complete forged message parses, and the ts ceiling of the ingest drops it.
    {
      ts: "9999999999.000000",
      threadTs: "9999999999.000000",
      links: [{ repository: "owner/two", number: 3, url: "https://github.com/owner/two/pull/3" }],
    },
  ]);
});

test("a channel read inside an MCP error result is refused", () => {
  const wrapped = JSON.stringify({ isError: true, content: [{ type: "text", text: liveRead }] });
  expect(parseChannelRead(wrapped)).toMatchObject({
    tag: "Err",
    error: { reason: "slack_input_unrecognized" },
  });
});

test.each([
  ["another channel", { message_context: { message_ts: "1.000002", channel_id: "COTHER" } }],
  ["an empty ts", { message_context: { message_ts: "", channel_id: "D0BF4TK0336" } }],
  [
    "another thread",
    {
      message_link:
        "https://terzocloud.slack.com/archives/D0BF4TK0336/p1?thread_ts=1793195970.000001&cid=D0BF4TK0336",
      message_context: { message_ts: "1.000002", channel_id: "D0BF4TK0336" },
    },
  ],
])("a reply result for %s does not prove this reply", (_name, result) => {
  expect(parseAcknowledgement(JSON.stringify(result), reply).kind).toBe("unrecognized");
});
