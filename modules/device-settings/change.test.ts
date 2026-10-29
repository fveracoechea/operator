import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary directory, directory creation, link, inode, or recursive removal API.
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromPromise, Ok, OkAsync } from "unthrown";
import { z } from "zod";
import { AgentHosts } from "../agent-hosts/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { apply, plan, recover } from "./change.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-settings-change-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  mock.restore();
});

let homes = 0;
async function freshPaths() {
  homes += 1;
  const home = path.join(root, `home-${homes}`);
  await mkdir(home);
  return OperatorHome.resolve(Environment.parse({ HOME: home, NODE_ENV: "test" }));
}

const planned = z.object({
  reason: z.literal("settings_planned"),
  data: z.object({
    planId: z.string(),
    generation: z.string().nullable(),
    editsIdentity: z.string(),
    previousIdentity: z.string(),
    nextIdentity: z.string(),
    nextText: z.string(),
    changed: z.boolean(),
  }),
});
async function planOf(request: Parameters<typeof plan>[0]) {
  return planned.parse(await plan(request)).data;
}
async function readJson(file: string) {
  return z.json().parse(JSON.parse(await Bun.file(file).text()));
}
function resolvedHosts() {
  return spyOn(AgentHosts, "resolve").mockImplementation((input) =>
    OkAsync({ ...input, requestedModel: input.model, command: { tool: "opencode", args: [] } }),
  );
}

const recoveryRequired = {
  reason: "settings_recovery_required",
  detail:
    "Run operator config recover before another settings write. Preserve an unreadable or unmatched receipt for inspection.",
} as const;
const writeUnconfirmed = {
  reason: "settings_write_unconfirmed",
  detail:
    "The settings write could not be verified. Run operator config recover before another edit.",
} as const;
const externallyOwned = {
  reason: "settings_external",
  detail:
    "Settings are linked or read-only. Edit the external configuration, such as your Nix or Home Manager configuration, then rebuild it. Operator will not replace its file or link.",
} as const;
const defaults = { $schema: "./config.schema.json", superAgent: {}, workerAgent: {} };

test("binds plans to both device locations and receipts so old plans cannot replay after another edit", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  const first = (await planOf(request)).planId;
  const other = (await planOf({ ...request, paths: { ...paths, receipt: `${root}/different` } }))
    .planId;
  expect(other).not.toBe(first);
  expect(await apply({ ...request, planId: first })).toMatchObject({ reason: "settings_applied" });
  const unset = { ...request, sets: [], unsets: ["superAgent.host"] };
  const second = await planOf(unset);
  expect(second.generation).toBe(first);
  expect(await apply({ ...unset, planId: second.planId })).toMatchObject({
    reason: "settings_applied",
  });
  expect(await apply({ ...request, planId: first })).toEqual({
    reason: "settings_plan_stale",
    detail: "The inspected settings or receipt changed. Make a new plan.",
  });
  expect(await readJson(paths.config)).toEqual(defaults);
});

test("plans the exact next settings without a write", async () => {
  const paths = await freshPaths();
  expect(await plan({ paths, sets: ["superAgent.host=opencode"], unsets: [] })).toMatchObject({
    reason: "settings_planned",
    data: {
      generation: null,
      changed: true,
      path: paths.config,
      before: defaults,
      after: { ...defaults, superAgent: { host: "opencode" } },
      nextText: `${JSON.stringify({ ...defaults, superAgent: { host: "opencode" } }, null, 2)}\n`,
    },
  });
  expect(await Bun.file(paths.config).exists()).toBe(false);
  expect(await Bun.file(paths.receipt).exists()).toBe(false);
});

test("refuses unsupported edits before any read or write", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: ["bogus=1", "superAgent.host="], unsets: [] };
  const refusal = {
    reason: "invalid_settings_edit",
    detail:
      "Unsupported settings field: bogus=1.\nSet superAgent.host with a non-empty path=value argument.",
  } as const;
  expect(await plan(request)).toEqual(refusal);
  expect(await apply({ ...request, planId: "any" })).toEqual(refusal);
  expect(await Bun.file(paths.config).exists()).toBe(false);
  expect(await Bun.file(paths.receipt).exists()).toBe(false);
});

test("refuses edits that the settings schema rejects", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: ["review.channel=bad"], unsets: [] };
  for (const result of [await plan(request), await apply({ ...request, planId: "any" })]) {
    expect(Object.keys(result)).toEqual(["reason", "detail"]);
    expect(result).toMatchObject({ reason: "invalid_settings_edit" });
    expect("detail" in result && result.detail).toContain("channel");
  }
  expect(await Bun.file(paths.config).exists()).toBe(false);
});

test("requires a plan ID before an apply", async () => {
  const paths = await freshPaths();
  expect(await apply({ paths, sets: ["superAgent.host=opencode"], unsets: [] })).toEqual({
    reason: "settings_plan_required",
    detail: "Run operator config plan with these edits, then pass its ID with --plan.",
  });
  expect(await Bun.file(paths.config).exists()).toBe(false);
});

test("validates host selections in the requested directory and refuses orphan models", async () => {
  const paths = await freshPaths();
  const resolve = resolvedHosts();
  const request = {
    paths,
    sets: ["superAgent.host=opencode", "superAgent.model=chosen"],
    unsets: [],
    cwd: "/requested",
  };
  const { planId } = await planOf(request);
  expect(await apply({ ...request, planId })).toMatchObject({ reason: "settings_applied" });
  expect(resolve.mock.calls.map(([input]) => input.cwd)).toEqual([
    "/requested",
    "/requested",
    "/requested",
    "/requested",
  ]);
  const orphan = {
    paths: await freshPaths(),
    sets: ["workerAgent.model=orphan"],
    unsets: [],
    cwd: "/requested",
  };
  expect(await plan(orphan)).toMatchObject({ reason: "selection_incomplete" });
  expect(await apply({ ...orphan, planId: "any" })).toMatchObject({
    reason: "selection_incomplete",
  });
  expect(await readJson(paths.config)).toEqual({
    ...defaults,
    superAgent: { host: "opencode", model: "chosen" },
  });
  expect(await Bun.file(orphan.paths.config).exists()).toBe(false);
});

test("refuses plans and applies while a receipt is unreadable or pending", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  const { planId } = await planOf(request);
  await Bun.write(paths.receipt, "unreadable", { createPath: true });
  expect(await plan(request)).toEqual(recoveryRequired);
  expect(await apply({ ...request, planId })).toEqual(recoveryRequired);
  expect(await recover(paths)).toEqual(recoveryRequired);
  expect(await Bun.file(paths.receipt).text()).toBe("unreadable");
  const pending = JSON.stringify({
    planId: "other",
    generation: null,
    editsIdentity: "other",
    previousIdentity: "other",
    nextIdentity: "other",
    state: "pending",
  });
  await Bun.write(paths.receipt, pending);
  expect(await plan(request)).toEqual(recoveryRequired);
  expect(await apply({ ...request, planId })).toEqual(recoveryRequired);
  expect(await recover(paths)).toEqual(recoveryRequired);
  expect(await Bun.file(paths.receipt).text()).toBe(pending);
  expect(await Bun.file(paths.config).exists()).toBe(false);
});

test("repeats an applied plan and settles only a pending receipt", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  const { planId } = await planOf(request);
  expect(await apply({ ...request, planId })).toMatchObject({ reason: "settings_applied" });
  const settled = await Bun.file(paths.receipt).text();
  const inode = (await stat(paths.receipt)).ino;
  const repeated = { reason: "settings_unchanged", data: { repeated: true } } as const;
  expect(await apply({ ...request, planId })).toEqual(repeated);
  expect((await stat(paths.receipt)).ino).toBe(inode);
  await Bun.write(paths.receipt, settled.replace('"complete"', '"pending"'));
  expect(await apply({ ...request, planId })).toEqual(repeated);
  expect(await Bun.file(paths.receipt).text()).toBe(settled);
});

test("reports an edit that changes nothing without a write", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  expect(await apply({ ...request, planId: (await planOf(request)).planId })).toMatchObject({
    reason: "settings_applied",
  });
  const again = await planOf(request);
  expect(again).toMatchObject({ changed: false });
  const receipt = await Bun.file(paths.receipt).text();
  expect(await apply({ ...request, planId: again.planId })).toEqual({
    reason: "settings_unchanged",
    data: { repeated: false },
  });
  expect(await Bun.file(paths.receipt).text()).toBe(receipt);
});

test("writes the default settings when an unset edit meets an absent file", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: [], unsets: ["superAgent.host"] };
  const { planId } = await planOf(request);
  expect(await apply({ ...request, planId })).toMatchObject({ reason: "settings_applied" });
  expect(await readJson(paths.config)).toEqual(defaults);
});

test("refuses a linked settings file and one that becomes linked during validation", async () => {
  const paths = await freshPaths();
  const text = JSON.stringify({ superAgent: { host: "opencode", model: "chosen" } });
  const external = path.join(root, `external-${homes}.json`);
  await Bun.write(external, text);
  await mkdir(paths.configRoot, { recursive: true });
  await symlink(external, paths.config);
  const request = { paths, sets: ["superAgent.reasoningEffort=low"], unsets: [] };
  const resolve = resolvedHosts();
  const { planId } = await planOf(request);
  const discoveries = resolve.mock.calls.length;
  expect(await apply({ ...request, planId })).toEqual(externallyOwned);
  expect(resolve.mock.calls.length).toBe(discoveries);
  expect(await Bun.file(paths.writeLock).exists()).toBe(false);
  await rm(paths.config);
  await Bun.write(paths.config, text);
  const linked = await planOf(request);
  mock.restore();
  spyOn(AgentHosts, "resolve").mockImplementation((input) =>
    fromPromise(
      async () => {
        await rm(paths.config, { force: true });
        await symlink(external, paths.config);
        return { ...input, requestedModel: input.model, command: { tool: "opencode", args: [] } };
      },
      (cause, defect) => defect(cause),
    ).flatMap((resolved) => Ok(resolved)),
  );
  expect(await apply({ ...request, planId: linked.planId })).toEqual(externallyOwned);
  expect(await Bun.file(paths.receipt).exists()).toBe(false);
  expect(await Bun.file(external).text()).toBe(text);
});

test("aborts the write when the settings become read-only before the write", async () => {
  const base = await freshPaths();
  // The temporary file lives outside the settings folder, so only the folder mode changes.
  const paths = { ...base, configTemporary: path.join(base.configState, "config.json.tmp") };
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  const { planId } = await planOf(request);
  await mkdir(paths.configState, { recursive: true });
  await mkdir(path.dirname(paths.configRoot), { recursive: true });
  // The settings folder does not exist yet, so the write creates it read-only.
  const umask = process.umask(0o222);
  try {
    expect(await apply({ ...request, planId })).toEqual({
      reason: "settings_plan_stale",
      detail: "The settings changed before the write. Make a new plan.",
    });
  } finally {
    process.umask(umask);
  }
  expect(await readJson(paths.receipt)).toMatchObject({ planId, state: "aborted" });
  expect(await Bun.file(paths.config).exists()).toBe(false);
  expect(await Bun.file(paths.configTemporary).exists()).toBe(false);
});

test("keeps a pending receipt when the settings write cannot be confirmed", async () => {
  const paths = await freshPaths();
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  const { planId } = await planOf(request);
  await Bun.write(paths.configTemporary, "unowned\n", { createPath: true });
  expect(await apply({ ...request, planId })).toEqual(writeUnconfirmed);
  expect(await readJson(paths.receipt)).toMatchObject({ planId, state: "pending" });
  expect(await Bun.file(paths.configTemporary).text()).toBe("unowned\n");
  expect(await Bun.file(paths.config).exists()).toBe(false);
});

test("keeps a pending receipt and rethrows an unexpected write defect", async () => {
  const base = await freshPaths();
  const paths = { ...base, configTemporary: path.join(base.configRoot, "x".repeat(300)) };
  const request = { paths, sets: ["superAgent.host=opencode"], unsets: [] };
  const { planId } = await planOf(request);
  expect(apply({ ...request, planId })).rejects.toMatchObject({ code: "ENAMETOOLONG" });
  await Bun.sleep(0);
  expect(await readJson(paths.receipt)).toMatchObject({ planId, state: "pending" });
  expect(await Bun.file(paths.config).exists()).toBe(false);
});

test("recovers a pending receipt only from its exact before or after settings", async () => {
  const paths = await freshPaths();
  expect(await recover(paths)).toEqual({ reason: "settings_recovered", data: { state: "absent" } });
  const intent = await planOf({ paths, sets: ["superAgent.host=opencode"], unsets: [] });
  const { nextText, changed: _, ...fields } = intent;
  const pending = { ...fields, state: "pending" };
  await Bun.write(paths.receipt, JSON.stringify(pending), { createPath: true });
  expect(await recover(paths)).toEqual({
    reason: "settings_recovered",
    data: { state: "aborted", planId: intent.planId },
  });
  expect(await readJson(paths.receipt)).toEqual({ ...pending, state: "aborted" });
  expect(await recover(paths)).toEqual({
    reason: "settings_recovered",
    data: { state: "aborted" },
  });
  await Bun.write(paths.receipt, JSON.stringify(pending));
  await Bun.write(paths.config, nextText, { createPath: true });
  expect(await recover(paths)).toEqual({
    reason: "settings_recovered",
    data: { state: "complete", planId: intent.planId },
  });
  expect(await readJson(paths.receipt)).toEqual({ ...pending, state: "complete" });
});
