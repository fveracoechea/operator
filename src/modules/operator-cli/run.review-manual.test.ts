import { afterEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { reviewDevice, url } from "./review-fixture.ts";

let device: Awaited<ReturnType<typeof reviewDevice>> | null = null;
afterEach(async () => {
  if (device !== null) await rm(device.root, { recursive: true, force: true });
  device = null;
});

test("the migration renames the slack origin to manual", async () => {
  device = await reviewDevice();
  const file = `${device.root}/state/operator/operator.sqlite`;
  await rm(file);
  {
    using db = new Database(file);
    db.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    );
    const migrations = readMigrationFiles({
      migrationsFolder: Bun.fileURLToPath(new URL("../device-state/migrations/", import.meta.url)),
    });
    for (const migration of migrations.slice(0, 20)) {
      for (const sql of migration.sql) db.exec(sql);
      db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
        migration.hash,
        migration.folderMillis,
      );
    }
    db.query("INSERT INTO projects VALUES ('example/one', ?, 'now')").run(device.checkout);
    db.exec(
      "INSERT INTO review_requests (id, repository, number, url, origin, state, requested_at, slack_channel, slack_ts) VALUES ('manual', 'example/one', 7, 'https://github.com/example/one/pull/7', 'slack', 'queued', 'now', 'C0123', '1234.000005'), ('assignment', 'example/one', 8, 'https://github.com/example/one/pull/8', 'assignment', 'queued', 'now', NULL, NULL)",
    );
  }
  expect(await device.next()).toMatchObject([
    { id: "manual", origin: "manual", slackThread: "https://slack.com/archives/C0123/p1234000005" },
    { id: "assignment", origin: "assignment", slackThread: null },
  ]);
  {
    using db = new Database(file, { readonly: true });
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE name IN ('slack_effects', 'slack_watches')")
        .all(),
    ).toEqual([]);
  }
  expect(await device.next()).toMatchObject([{ origin: "manual" }, { origin: "assignment" }]);
});

test("a retired channel setting remains readable without writes but cannot be configured", async () => {
  device = await reviewDevice();
  const file = `${device.root}/config/operator/config.json`;
  const original = z.looseObject({}).parse(await Bun.file(file).json());
  const settings = {
    ...original,
    review: { channel: "C0REVIEW", repos: ["example/one"], authors: ["author"] },
  };
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  await Bun.write(file, text);
  await chmod(file, 0o444);
  const calls = await device.herdrCalls();
  const shown = await device.run(["config", "show"]);
  expect(shown.code, shown.stderr).toBe(0);
  expect(shown.output).toMatchObject({
    data: { config: { review: { repos: ["example/one"], authors: ["author"] } } },
  });
  expect(JSON.stringify(shown.output)).not.toContain('"channel"');
  expect((await device.run(["review", "add", url])).code).toBe(0);
  for (const flags of [
    ["--set", "review.channel=C0123"],
    ["--unset", "review.channel"],
  ]) {
    expect(await device.run(["config", "apply", ...flags])).toMatchObject({
      code: 2,
      output: { reason: "invalid_settings_edit" },
    });
  }
  expect(await device.herdrCalls()).toEqual(calls);
  expect(await Bun.file(file).text()).toBe(text);
  await chmod(file, 0o644);
  for (const invalid of [
    { ...settings, unrelated: true },
    { ...settings, review: { ...settings.review, unknown: true } },
    { ...settings, review: { ...settings.review, authors: 7 } },
    { ...settings, review: { ...settings.review, channel: 7 } },
  ]) {
    await Bun.write(file, JSON.stringify(invalid));
    expect(await device.run(["config", "show"])).toMatchObject({
      code: 2,
      output: { reason: "invalid_settings" },
    });
  }
});

test.each([
  {},
  { review: { repos: ["example/one"], authors: [] } },
  { review: { repos: ["example/two"], authors: ["author"] } },
])("review add excludes a PR outside either policy list without writes: %j", async (settings) => {
  device = await reviewDevice();
  await Bun.write(`${device.root}/config/operator/config.json`, JSON.stringify(settings));
  const before = await Bun.file(`${device.root}/state/operator/operator.sqlite`).bytes();
  const calls = await device.herdrCalls();
  expect(await device.run(["review", "add", url])).toMatchObject({
    code: 2,
    output: { reason: "review_author_excluded" },
  });
  expect(await device.next()).toEqual([]);
  expect(await device.githubState()).not.toHaveProperty("posted");
  expect(await device.herdrCalls()).toEqual(calls);
  expect(await Bun.file(`${device.root}/state/operator/operator.sqlite`).bytes()).toEqual(before);
});

test("review add applies the author policy and stores a slack thread link", async () => {
  device = await reviewDevice();
  const thread = "https://example.slack.com/archives/C0REVIEW/p1792003999000200";
  await device.pullRequest({ author: "outsider" });
  const refused = await device.run(["review", "add", url, "--slack-thread", thread]);
  expect(refused.code).toBe(2);
  expect(refused.output).toMatchObject({
    reason: "review_author_excluded",
    next: { decider: "super-agent" },
    state: { author: "outsider", repository: "example/one" },
  });
  expect(await device.next()).toEqual([]);
  await device.pullRequest({ author: "Author" });
  const added = await device.run(["review", "add", url, "--slack-thread", thread]);
  expect(added.code, added.stderr).toBe(0);
  expect(added.output).toMatchObject({ data: { origin: "manual", slackThread: thread } });
  expect(await device.next()).toMatchObject([{ slackThread: thread }]);
  expect((await device.run(["review", "add", url])).output).toMatchObject({
    data: { slackThread: thread },
  });
  const request = z.object({ data: z.object({ draft: z.string() }) }).parse(added.output).data;
  expect((await device.run(["review", "start", url])).code).toBe(0);
  await device.draft(request.draft, device.head);
  expect((await device.run(["review", "post", url])).code).toBe(0);
  const posted = z
    .array(
      z.object({
        slackThread: z.string(),
        next: z.object({ decider: z.string(), question: z.string() }),
      }),
    )
    .parse(await device.next());
  expect(posted[0]?.slackThread).toBe(thread);
  expect(posted[0]?.next.decider).toBe("super-agent");
  expect(posted[0]?.next.question).toContain("Reply once");
  device.sql("UPDATE review_requests SET cleanup_state = 'failed'");
  expect(await device.next()).toMatchObject([
    {
      action: "clean_reviewer",
      command: `operator review cleanup ${url}`,
      next: { command: `operator review cleanup ${url}` },
    },
  ]);
});
