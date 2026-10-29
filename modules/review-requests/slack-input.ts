import { Err, Ok, fromThrowable, type Result } from "unthrown";
import { z } from "zod";
import { pullRequestTarget, type Target } from "./github.ts";
import type { Failure } from "./request.ts";

const tsPattern = /^\d{1,12}\.\d{1,6}$/;
// The Slack MCP tools answer with JSON whose values are prose, not Slack API objects.
const channelReadSchema = z.looseObject({
  messages: z.string(),
  pagination_info: z.string().optional(),
});
const sentSchema = z.looseObject({
  // slack_send_message names the sent reply.
  message_link: z.string().optional(),
  message_context: z
    .looseObject({ message_ts: z.string().regex(tsPattern), channel_id: z.string() })
    .optional(),
  // slack_add_reaction answers in prose.
  result: z.string().optional(),
  error: z.string().optional(),
  ok: z.boolean().optional(),
});
const toolResultSchema = z.looseObject({
  isError: z.boolean().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});
// The live header: `=== Message from <name> (<user id>) at <YYYY-MM-DD HH:MM:SS TZ> ===`.
const headerPattern =
  // Stryker disable next-line Regex: equivalent: text after a header on its line never starts with a TS line, so it joins the message before it either way
  /^=== Message from .+ \([UWB][A-Z0-9]+\) at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5} ===[ \t]*$/m;
const tsLinePattern = /^\s*Message TS: (\d{1,12}\.\d{1,6})[ \t]*$/m;
const linkPattern = /https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+/g;
const morePattern = /There are more messages available/;
/** A raw MCP tool result wraps its answer in text content. At most this many layers are opened. */
const wrapLimit = 3;

export type ChannelMessage = { ts: string; threadTs: string; links: Target[] };
type ChannelRead = z.infer<typeof channelReadSchema>;

/** Parses JSON text with one schema, or gives undefined for other text. */
function parseText<T>(text: string, schema: z.ZodType<T>): T | undefined {
  // JSON.parse of a string throws only a SyntaxError, so any throw means other text.
  const value = fromThrowable(
    () => JSON.parse(text) as unknown,
    () => undefined,
  )().getOr(undefined);
  return schema.safeParse(value).data;
}

/** The channel read in the text, directly or inside the text content of a tool result. */
function channelReadOf(text: string, depth = 0): ChannelRead | undefined {
  const read = parseText(text, channelReadSchema);
  if (read !== undefined) return read;
  const wrapper = parseText(text, toolResultSchema);
  // An MCP error result is not a read, whatever its text holds.
  if (wrapper === undefined || wrapper.isError === true || depth >= wrapLimit) return undefined;
  for (const part of wrapper.content) {
    // Stryker disable next-line ConditionalExpression: equivalent: a part without text parses as no JSON, so it also gives no read
    const inner = part.text === undefined ? undefined : channelReadOf(part.text, depth + 1);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** Compares two Slack ts values as numbers, without float rounding. */
export function compareTs(left: string, right: string) {
  // Stryker disable next-line StringLiteral: no rule: split always gives the seconds, and every Slack ts that Operator compares has its fraction
  const [leftSeconds = "0", leftMicros = ""] = left.split(".");
  // Stryker disable next-line StringLiteral: no rule: split always gives the seconds, and every Slack ts that Operator compares has its fraction
  const [rightSeconds = "0", rightMicros = ""] = right.split(".");
  const seconds = BigInt(leftSeconds) - BigInt(rightSeconds);
  const difference =
    seconds === 0n
      ? BigInt(leftMicros.padEnd(6, "0")) - BigInt(rightMicros.padEnd(6, "0"))
      : seconds;
  return Number(difference > 0n) - Number(difference < 0n);
}

/** The Slack ts of a moment, the form that `oldest` takes. */
export function slackTs(milliseconds: number) {
  return `${Math.floor(milliseconds / 1000)}.000000`;
}

function uniqueLinks(targets: Target[]) {
  return [...new Map(targets.map((target) => [target.url, target])).values()];
}

/** Every PR link in the prose of one message, each once. */
function linksOf(body: string) {
  return uniqueLinks(
    [...body.matchAll(linkPattern)].flatMap((match) => pullRequestTarget(match[0]) ?? []),
  );
}

/**
 * The messages of the prose history. Each starts with its header, then its `Message TS` line.
 * Slack does not escape a header-like line in a message body, so a block without its own TS line
 * belongs to the message before it. Only a first block without one refuses the read.
 */
function messagesOf(prose: string): ChannelMessage[] | null {
  // Stryker disable next-line StringLiteral: equivalent: split always gives a first part, so the default never applies
  const [preamble = "", ...blocks] = prose.split(headerPattern);
  // A TS line before the first header means a header form that this parser does not know.
  if (tsLinePattern.test(preamble)) return null;
  const messages: ChannelMessage[] = [];
  for (const block of blocks) {
    const ts = tsLinePattern.exec(block);
    const previous = messages.at(-1);
    // Stryker disable next-line MethodExpression: equivalent: the TS pattern starts at the line start with \s*, so text before a match is never only whitespace
    if (ts !== null && block.slice(0, ts.index).trim() === "") {
      // The TS line holds no link, so the links of the whole block are the links of its body.
      // Channel history holds only top-level messages, so each message is its own thread.
      // Stryker disable next-line StringLiteral: equivalent: a TS match always captures its ts group
      messages.push({ ts: ts[1] ?? "", threadTs: ts[1] ?? "", links: linksOf(block) });
    } else if (previous === undefined) return null;
    else previous.links = uniqueLinks([...previous.links, ...linksOf(block)]);
  }
  return messages;
}

/**
 * Reads the raw result of one `slack_read_channel` call: JSON with a prose `messages` history and
 * prose `pagination_info`, directly or inside the text content of an MCP tool result. Each message
 * gives its ts and its PR links. Any other shape is refused, so it never moves the cursor.
 */
export function parseChannelRead(
  text: string,
): Result<{ messages: ChannelMessage[]; hasMore: boolean }, Failure> {
  const read = channelReadOf(text);
  const messages = read === undefined ? null : messagesOf(read.messages);
  // Stryker disable next-line ConditionalExpression: equivalent: an undefined read always gives null messages
  if (read === undefined || messages === null)
    return Err({
      reason: "slack_input_unrecognized",
      detail:
        "The input is not a slack_read_channel result with a messages history, each message with its Message TS line. Pipe the unchanged result. Nothing was recorded, and the cursor did not move.",
    });
  return Ok({
    messages: messages.toSorted((left, right) => compareTs(left.ts, right.ts)),
    hasMore: morePattern.test(String(read.pagination_info)),
  });
}

/** The effect that a send result must prove. */
export type Expected =
  | { kind: "reply"; channel: string; threadTs: string }
  | { kind: "reaction"; emoji: string };
type Sent =
  | { kind: "done"; slackTs: string | null }
  | { kind: "failed"; detail: string }
  | { kind: "unrecognized"; detail: string };

/** The send result inside a tool result. An MCP error marks the wrapper, not its text. */
function readWrapped(
  wrapper: z.infer<typeof toolResultSchema>,
  text: string,
  expected: Expected,
  depth: number,
) {
  if (wrapper.isError === true) return { kind: "failed" as const, detail: text.slice(0, 300) };
  if (depth >= wrapLimit) return null;
  for (const part of wrapper.content) {
    // Stryker disable next-line ConditionalExpression: equivalent: a part without text parses as no JSON, so it also gives null
    const inner = part.text === undefined ? null : readSent(part.text, expected, depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * A reply result proves this reply only for its channel and, when the link names one, its thread.
 * Two pending replies cannot then take each other's result.
 */
function sentReply(
  sent: z.infer<typeof sentSchema>,
  expected: Extract<Expected, { kind: "reply" }>,
): Sent | null {
  const context = sent.message_context;
  if (context === undefined || context.channel_id !== expected.channel) return null;
  // A missing link parses as no URL.
  const link = URL.parse(String(sent.message_link));
  if (sent.message_link !== undefined && link?.searchParams.get("thread_ts") !== expected.threadTs)
    return null;
  return { kind: "done", slackTs: context.message_ts };
}

/**
 * A Slack answer. An error fails. A reply needs the ts of the sent message, and a reaction needs
 * the success sentence for the same reaction. A repeated reaction gives that sentence too.
 */
function readAnswer(sent: z.infer<typeof sentSchema>, expected: Expected): Sent | null {
  if (sent.error !== undefined || sent.ok === false)
    return { kind: "failed", detail: sent.error ?? "Slack answered ok: false." };
  if (expected.kind === "reply") return sentReply(sent, expected);
  return sent.result?.startsWith(`Successfully added :${expected.emoji}: reaction`) === true
    ? { kind: "done", slackTs: null }
    : null;
}

/** One layer of a send result, or null when it shows neither success nor a failure. */
function readSent(text: string, expected: Expected, depth = 0): Sent | null {
  const wrapper = parseText(text, toolResultSchema);
  if (wrapper !== undefined) return readWrapped(wrapper, text, expected, depth);
  const sent = parseText(text, sentSchema);
  return sent === undefined ? null : readAnswer(sent, expected);
}

/**
 * Reads the raw result of one send for the effect it must prove. Only positive evidence marks it
 * done. An error fails, and any other result is unrecognized, so an unknown answer never ends an
 * effect.
 */
export function parseAcknowledgement(text: string, expected: Expected): Sent {
  if (text.trim() === "") return { kind: "unrecognized", detail: "The send result is empty." };
  return (
    readSent(text, expected) ?? {
      kind: "unrecognized",
      detail: `The send result shows no success for this ${expected.kind}: ${text.slice(0, 300)}`,
    }
  );
}

type Watch = { cursor: string; latest: string | null; pending: string | null };

function newest(values: (string | null)[]) {
  return values.reduce<string | null>(
    (best, value) =>
      // Stryker disable next-line EqualityOperator: no rule: two equal ts values name the same moment, so either form is the newest
      value !== null && (best === null || compareTs(value, best) > 0) ? value : best,
    null,
  );
}

/**
 * The messages of one read that the cursor has not passed, and the next cursor state. Slack gives
 * the newest page first. While it says that it has more, the cursor stays and the next read asks
 * for the messages before this page. The last page moves the cursor to the newest message seen.
 */
export function advanceWatch(
  from: Watch,
  read: { messages: ChannelMessage[]; hasMore: boolean },
  /** The newest ts that can exist at the ingest. A message body can forge a later one. */
  ceiling: string,
) {
  const fresh = read.messages.filter(
    (message) =>
      compareTs(message.ts, from.cursor) > 0 &&
      compareTs(message.ts, ceiling) <= 0 &&
      (from.latest === null || compareTs(message.ts, from.latest) < 0),
  );
  const seen = newest([from.pending, ...fresh.map((message) => message.ts)]);
  const oldest = fresh[0]?.ts ?? null;
  // A page with no new message cannot page further, so the read ends there.
  if (read.hasMore && oldest !== null)
    return { fresh, to: { cursor: from.cursor, latest: oldest, pending: seen, paging: true } };
  return {
    fresh,
    to: {
      cursor: newest([from.cursor, seen]) ?? from.cursor,
      latest: null,
      pending: null,
      paging: false,
    },
  };
}
