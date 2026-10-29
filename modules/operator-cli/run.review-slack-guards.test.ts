import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no recursive copy, temporary-directory, or symlink API.
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";

const source = Bun.fileURLToPath(new URL("../../", import.meta.url));
let root = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-slack-guards-"));
  for (const file of [
    "modules",
    "lib",
    "scripts",
    "tools",
    "skills",
    "cli.ts",
    "package.json",
    "bunfig.toml",
    "tsconfig.json",
  ])
    await cp(`${source}/${file}`, `${root}/${file}`, { recursive: true });
  await symlink(`${source}/node_modules`, `${root}/node_modules`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const scenarios = "operator-cli/run.review-slack.test.ts";
const ingestScenario = "ingests a raw channel read through the author policy";

test.each([
  {
    name: "repository policy",
    file: "review-requests/slack.ts",
    replacements: [["if (!chosen.repos.includes(target.repository))", "if (false)"]],
    testFile: scenarios,
    pattern: ingestScenario,
  },
  {
    name: "author policy",
    file: "review-requests/slack.ts",
    replacements: [
      ['if (!authors.includes((pr.author ?? "").toLowerCase())) return', "if (false) return"],
    ],
    testFile: scenarios,
    pattern: ingestScenario,
  },
  {
    name: "only messages after the cursor",
    file: "review-requests/slack-input.ts",
    replacements: [["compareTs(message.ts, from.cursor) > 0", "true"]],
    testFile: scenarios,
    pattern: ingestScenario,
  },
  {
    name: "a skip is for one PR and stays",
    file: "device-state/slack.ts",
    replacements: [['if (latest.state === "skipped") return "skipped";', ""]],
    testFile: scenarios,
    pattern: ingestScenario,
  },
  {
    name: "one ingest per cursor",
    file: "device-state/slack.ts",
    replacements: [["watch.cursor !== input.from.cursor ||", ""]],
    testFile: "device-state/slack.test.ts",
    pattern: "a cursor that another ingest moved refuses with no write",
  },
  {
    name: "one ingest per paging state",
    file: "device-state/slack.ts",
    replacements: [
      ["watch.latest !== input.from.latest ||", ""],
      ["watch.pending !== input.from.pending", "false"],
    ],
    testFile: "device-state/slack.test.ts",
    pattern: "a page keeps the cursor, records the paging bound",
  },
  {
    name: "a page keeps the cursor",
    file: "review-requests/slack-input.ts",
    replacements: [["if (read.hasMore && oldest !== null)", "if (false)"]],
    testFile: scenarios,
    pattern: "a paged channel read keeps the cursor",
  },
  {
    name: "a reply needs the ts of the sent message",
    file: "review-requests/slack-input.ts",
    replacements: [["message_ts: z.string().regex(tsPattern)", "message_ts: z.string()"]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "a reply result for an empty ts",
  },
  {
    name: "a reaction needs its own success sentence",
    file: "review-requests/slack-input.ts",
    replacements: [["reaction`) === true", "reaction`) !== undefined"]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "another reaction",
  },
  {
    name: "a reply result names this channel",
    file: "review-requests/slack-input.ts",
    replacements: [["context.channel_id !== expected.channel", "false"]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "a reply result for another channel",
  },
  {
    name: "a reply result names this thread",
    file: "review-requests/slack-input.ts",
    replacements: [['link?.searchParams.get("thread_ts") !== expected.threadTs', "false"]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "a reply result for another thread",
  },
  {
    name: "a forged later ts cannot move the cursor",
    file: "review-requests/slack-input.ts",
    replacements: [["compareTs(message.ts, ceiling) <= 0 &&", ""]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "a ts after the ingest moment",
  },
  {
    name: "a forged header stays in its message",
    file: "review-requests/slack-input.ts",
    replacements: [
      [
        "else previous.links = uniqueLinks([...previous.links, ...linksOf(block)]);",
        "else return null;",
      ],
    ],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "a header line in a message body",
  },
  {
    name: "an unknown header form is refused",
    file: "review-requests/slack-input.ts",
    replacements: [["if (tsLinePattern.test(preamble)) return null;", ""]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "an unknown header form",
  },
  {
    name: "a read in an MCP error is refused",
    file: "review-requests/slack-input.ts",
    replacements: [["wrapper.isError === true || depth", "depth"]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "a channel read inside an MCP error result",
  },
  {
    name: "an error field fails",
    file: "review-requests/slack-input.ts",
    replacements: [["sent.error !== undefined || ", ""]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "an error field fails",
  },
  {
    name: "the ts line starts its message",
    file: "review-requests/slack-input.ts",
    replacements: [['ts !== null && block.slice(0, ts.index).trim() === ""', "ts !== null"]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "a ts line after the body",
  },
  {
    name: "an unknown send result stays pending",
    file: "review-requests/slack-input.ts",
    replacements: [
      [
        'kind: "unrecognized",\n      detail: `The send result',
        'kind: "done",\n      slackTs: null,\n      detail: `The send result',
      ],
    ],
    testFile: scenarios,
    pattern: ingestScenario,
  },
  {
    name: "only the Slack loop waits on Slack",
    file: "review-requests/watch.ts",
    replacements: [["loop.slack &&", "true &&"]],
    testFile: scenarios,
    pattern: "a host without Slack tools never waits on Slack",
  },
  {
    name: "next records no cursor",
    file: "review-requests/slack.ts",
    replacements: [["const started = start", "const started = true"]],
    testFile: scenarios,
    pattern: "a host without Slack tools never waits on Slack",
  },
  {
    name: "an assignment review takes no Slack thread",
    file: "device-state/slack.ts",
    replacements: [['if (latest.origin === "assignment") return "assignment";', ""]],
    testFile: "device-state/slack.test.ts",
    pattern: "an approved request and an assignment review take no Slack thread",
  },
  {
    name: "one effect per key",
    file: "device-state/review-requests.ts",
    replacements: [[".onConflictDoNothing()", ""]],
    testFile: "device-state/slack.test.ts",
    pattern: "records each effect key once",
  },
  {
    name: "a refused send stays pending",
    file: "device-state/slack.ts",
    replacements: [
      [": { failure: outcome.detail }", ': { state: "done", failure: outcome.detail }'],
    ],
    testFile: scenarios,
    pattern: ingestScenario,
  },
  {
    name: "an MCP error result is a refused send",
    file: "review-requests/slack-input.ts",
    replacements: [["if (wrapper.isError === true)", "if (false)"]],
    testFile: "review-requests/slack-input.test.ts",
    pattern: "an MCP error result",
  },
  {
    name: "an unknown read never moves the cursor",
    file: "review-requests/slack-input.ts",
    replacements: [["if (read === undefined || messages === null)", "if (false)"]],
    testFile: scenarios,
    pattern: "a refused ingest records nothing and keeps the cursor",
  },
  {
    name: "round effects in the posted write",
    file: "review-requests/post.ts",
    replacements: [["effects: roundEffects(current.rounds, round, target.url),", ""]],
    testFile: scenarios,
    pattern: "each posted round gets one reply and an additive reaction",
  },
  {
    name: "at most three blocker bullets",
    file: "review-requests/slack-effects.ts",
    replacements: [[".slice(0, bulletLimit)", ""]],
    testFile: "review-requests/slack-effects.test.ts",
    pattern: "a first round shows its status",
  },
  {
    name: "later-round progress",
    file: "review-requests/slack-effects.ts",
    replacements: [["Math.max(0, before - blockers.length)", "before"]],
    testFile: "review-requests/slack-effects.test.ts",
    pattern: "a later round says how many earlier blockers are gone",
  },
  {
    name: "head-limit suffix only at the limit",
    file: "review-requests/slack-effects.ts",
    replacements: [['limit === null ? ""', 'true ? ""']],
    testFile: "review-requests/slack-effects.test.ts",
    pattern: "the reviewed-at suffix appears only at the head-move limit",
  },
  {
    name: "no Slack without a channel",
    file: "review-requests/slack.ts",
    replacements: [["if (chosen === null) return OkAsync(null);", ""]],
    testFile: scenarios,
    pattern: "without a channel, review waits and next read no Slack",
  },
])(
  "a deliberate break of Slack guard $name makes its behavior test fail",
  async (change) => {
    const file = `${root}/modules/${change.file}`;
    const original = await Bun.file(file).text();
    let changed = original;
    for (const [before, after] of change.replacements) {
      expect(original).toContain(before);
      changed = changed.replace(before, after);
    }
    try {
      await Bun.write(file, changed);
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "test",
          `modules/${change.testFile}`,
          "--test-name-pattern",
          change.pattern,
        ],
        {
          cwd: root,
          env: Environment.child({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${stdout}${stderr}`).toBe(1);
      expect(`${stdout}${stderr}`).toContain("(fail)");
      expect(`${stdout}${stderr}`).toContain(change.pattern);
    } finally {
      await Bun.write(file, original);
    }
  },
  180000,
);
