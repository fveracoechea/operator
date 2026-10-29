import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OkAsync } from "unthrown";
import { AgentHosts } from "../agent-hosts/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { DeviceSettings } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-settings-module-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  mock.restore();
});

let homes = 0;
function freshPaths() {
  homes += 1;
  return OperatorHome.resolve(
    Environment.parse({ HOME: path.join(root, `home-${homes}`), NODE_ENV: "test" }),
  );
}

test("returns expected edit failures as Err and does not write", async () => {
  const result = await DeviceSettings.apply({
    paths,
    sets: ["superAgent.host=opencode"],
    unsets: [],
  });
  expect(result.tag).toBe("Err");
  if (result.tag === "Err") {
    expect(result.error.reason).toBe("settings_plan_required");
    expect(result.error).not.toHaveProperty("exitCode");
  }
  expect(await Bun.file(paths.config).exists()).toBe(false);
});

test("qualifies invalid input separately from unexpected defects", async () => {
  await Bun.write(paths.config, "{invalid", { createPath: true });
  const invalid = await DeviceSettings.show(paths);
  expect(invalid.tag).toBe("Err");
  if (invalid.tag === "Err") expect(invalid.error.reason).toBe("invalid_settings");
  expect(await DeviceSettings.resolve({ paths, cwd: root })).toMatchObject({
    tag: "Err",
    error: { reason: "invalid_settings" },
  });
  const defect = await DeviceSettings.show({ ...paths, config: "\0" });
  expect(defect.tag).toBe("Defect");
  expect(
    await DeviceSettings.resolve({ paths: { ...paths, config: "\0" }, cwd: root }),
  ).toMatchObject({ tag: "Defect" });
});

test("keeps settings read failures in the same operational channel for show and resolve", async () => {
  const unreadable = { ...paths, config: path.join(root, "unreadable") };
  const marker = path.join(unreadable.config, "preserved.txt");
  await Bun.write(marker, "preserved", { createPath: true });
  for (const result of [
    await DeviceSettings.show(unreadable),
    await DeviceSettings.resolve({ paths: unreadable, cwd: root }),
  ])
    expect(result).toMatchObject({ tag: "Err", error: { reason: "settings_io_failed" } });
  expect(await Bun.file(marker).text()).toBe("preserved");
});

test("plans, shows, and recovers settings through the interface", async () => {
  const fresh = freshPaths();
  expect(await DeviceSettings.show(fresh)).toMatchObject({
    tag: "Ok",
    value: { reason: "settings_read", data: { exists: false, path: fresh.config } },
  });
  expect(
    await DeviceSettings.plan({ paths: fresh, sets: ["superAgent.host=opencode"], unsets: [] }),
  ).toMatchObject({ tag: "Ok", value: { reason: "settings_planned" } });
  expect(await DeviceSettings.recover(fresh)).toMatchObject({
    tag: "Ok",
    value: { reason: "settings_recovered", data: { state: "absent" } },
  });
});

test("qualifies invalid settings for plan, apply, recover, and the review policy", async () => {
  const invalid = freshPaths();
  await Bun.write(invalid.config, "{invalid", { createPath: true });
  const request = { paths: invalid, sets: ["superAgent.host=opencode"], unsets: [] };
  for (const result of [
    await DeviceSettings.plan(request),
    await DeviceSettings.apply({ ...request, planId: "any" }),
    await DeviceSettings.slackReviewPolicy(invalid),
  ])
    expect(result).toMatchObject({ tag: "Err", error: { reason: "invalid_settings" } });
  await Bun.write(invalid.receipt, "{}", { createPath: true });
  expect(await DeviceSettings.recover(invalid)).toMatchObject({
    tag: "Err",
    error: { reason: "settings_recovery_required" },
  });
});

test("resolves the selected launch with its role and profile", async () => {
  const fresh = freshPaths();
  expect(await DeviceSettings.resolve({ paths: fresh, cwd: root })).toMatchObject({
    tag: "Err",
    error: { reason: "selection_incomplete" },
  });
  await Bun.write(
    fresh.config,
    JSON.stringify({ superAgent: { host: "opencode", model: "chosen" }, profiles: { study: {} } }),
    { createPath: true },
  );
  const resolve = spyOn(AgentHosts, "resolve").mockImplementation((input) =>
    OkAsync({
      host: input.host,
      model: "resolved",
      requestedModel: input.model,
      reasoningEffort: input.reasoningEffort,
      command: { tool: "opencode", args: ["mini"] },
    }),
  );
  expect(
    await DeviceSettings.resolve({ paths: fresh, cwd: root, role: "superAgent" }),
  ).toMatchObject({
    tag: "Ok",
    value: {
      host: "opencode",
      model: "resolved",
      requestedModel: "chosen",
      reasoningEffort: "high",
      command: { tool: "opencode", args: ["mini"] },
      role: "superAgent",
      profile: null,
    },
  });
  expect(await DeviceSettings.resolve({ paths: fresh, cwd: root, profile: "study" })).toMatchObject(
    { tag: "Ok", value: { reasoningEffort: "medium", role: "workerAgent", profile: "study" } },
  );
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({
    host: "opencode",
    model: "chosen",
    reasoningEffort: "high",
    cwd: root,
  });
});

test("reads the Slack review policy only when a channel is set", async () => {
  const fresh = freshPaths();
  expect(await DeviceSettings.slackReviewPolicy(fresh)).toMatchObject({ tag: "Ok", value: null });
  await Bun.write(fresh.config, JSON.stringify({ review: { assignments: true } }), {
    createPath: true,
  });
  expect(await DeviceSettings.slackReviewPolicy(fresh)).toMatchObject({ tag: "Ok", value: null });
  await Bun.write(fresh.config, JSON.stringify({ review: { channel: "C0123ABCD" } }));
  expect(await DeviceSettings.slackReviewPolicy(fresh)).toMatchObject({
    tag: "Ok",
    value: { channel: "C0123ABCD", repos: [], authors: [] },
  });
  const review = { channel: "C0123ABCD", repos: ["org/repo"], authors: ["octocat"] };
  await Bun.write(fresh.config, JSON.stringify({ review }));
  expect(await DeviceSettings.slackReviewPolicy(fresh)).toMatchObject({ tag: "Ok", value: review });
});

test("renders the editor schema for releases and edits", () => {
  const text = DeviceSettings.editorSchema();
  expect(text.endsWith("}\n")).toBe(true);
  expect(JSON.parse(text)).toMatchObject({ type: "object", additionalProperties: false });
});
