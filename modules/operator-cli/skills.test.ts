import { afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no platform temporary-root API.
import { tmpdir } from "node:os";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import { runSkills } from "./skills.ts";

const paths = OperatorHome.resolve(
  Environment.parse({ HOME: `${tmpdir()}/unused-skill-parser`, NODE_ENV: "test" }),
);

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

function quiet() {
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function spies() {
  return {
    owned: spyOn(OwnedSkills, "install").mockReturnValue(
      OkAsync({ reason: "skills_installed", data: { owned: true } }) as never,
    ),
    upstream: spyOn(UpstreamSkills, "install").mockReturnValue(
      OkAsync({ reason: "upstream_installed", data: { upstream: true } }) as never,
    ),
  };
}

test("rejects unsupported, duplicate, and target-free flags before installation", async () => {
  const called = spies();
  for (const args of [
    ["other"],
    ["other", "--claude"],
    ["install"],
    ["install", "--claude", "--claude"],
    ["install", "--claude", "--force"],
    ["install", "--check"],
    ["install", "matt"],
    ["install", "matt", "--claude", "--check"],
    ["install", "matt", "--json"],
  ])
    expect(await runSkills(args, paths, true)).toBe(false);
  for (const spy of Object.values(called)) expect(spy).not.toHaveBeenCalled();
});

test("installs owned skills for the selected hosts in host order", async () => {
  const called = spies();
  quiet();
  await runSkills(["install", "--claude", "--json", "--opencode"], paths, true);
  expect(called.owned).toHaveBeenLastCalledWith({
    paths,
    hosts: ["opencode", "claude-code"],
    check: false,
  });
  await runSkills(["install", "--check", "--claude"], paths, true);
  expect(called.owned).toHaveBeenLastCalledWith({ paths, hosts: ["claude-code"], check: true });
  await runSkills(["install", "--opencode"], paths, true);
  expect(called.owned).toHaveBeenLastCalledWith({ paths, hosts: ["opencode"], check: false });
  expect(called.upstream).not.toHaveBeenCalled();
});

test("installs upstream skills after it states the replacement policy", async () => {
  const called = spies();
  const { log, error } = quiet();
  await runSkills(["install", "matt", "--opencode", "--claude"], paths, true);
  expect(error).toHaveBeenCalledWith(UpstreamSkills.replacementPolicy());
  expect(called.upstream).toHaveBeenCalledWith(["opencode", "claude-code"], paths);
  expect(called.owned).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    reason: "upstream_installed",
    data: { upstream: true },
  });
});

test("prints a completed install as compact JSON or as indented text", async () => {
  spies();
  const { log, error } = quiet();
  const expected = {
    schemaVersion: 1,
    operation: "install",
    outcome: "completed",
    reason: "skills_installed",
    blockers: [],
    data: { owned: true },
  };
  process.exitCode = 7;
  expect(await runSkills(["install", "--claude"], paths, true)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected));
  expect(process.exitCode).toBe(0);
  expect(await runSkills(["install", "--claude"], paths, false)).toBe(true);
  expect(log).toHaveBeenLastCalledWith(JSON.stringify(expected, null, 2));
  expect(error).not.toHaveBeenCalled();
});

test.each([
  ["skill_copy_conflict", 4],
  ["skills_missing", 3],
  ["upstream_install_unconfirmed", 5],
  ["skill_io_failed", 1],
])("refuses %s with exit code %d", async (reason, code) => {
  spyOn(OwnedSkills, "install").mockReturnValue(
    ErrAsync({ reason, detail: "not installed" }) as never,
  );
  const { log, error } = quiet();
  expect(await runSkills(["install", "--claude"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "install",
    reason,
  });
  expect(error).toHaveBeenCalledWith("operator: not installed");
  expect(process.exitCode).toBe(code);
});

test("reports a skills defect with exit code 1", async () => {
  spyOn(OwnedSkills, "install").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("boom"))) as never,
  );
  const { log, error } = quiet();
  expect(await runSkills(["install", "--claude"], paths, true)).toBe(true);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "install",
    reason: "skills_defect",
  });
  expect(error).toHaveBeenCalledWith("operator: Error: boom");
  expect(process.exitCode).toBe(1);
});
