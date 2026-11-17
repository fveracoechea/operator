import { afterEach, expect, test, mock } from "bun:test";
import { parentCut } from "./stack-cut.ts";
import { prDevice, git, commit } from "./device-fixture.ts";

afterEach(() => {
  mock.restore();
});

test("rewritten parent attribution accepts the latest inherited branch head and rejects a requested older ancestor", async () => {
  await using device = await prDevice();
  const cwd = device.checkout;
  git(cwd, "checkout", "-qb", "task/parent");
  const root = git(cwd, "rev-parse", "HEAD");
  await commit(cwd, "parent", "parent");
  const cut = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-qb", "task/child");
  await commit(cwd, "child", "child");
  const child = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-qb", "replacement", root);
  await commit(cwd, "replacement", "replacement");
  const replacement = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/heads/task/parent", replacement, cut);
  const input = {
    cwd,
    branch: "task/parent",
    remote: "origin",
    parentHead: replacement,
    childHead: child,
  };
  expect(await parentCut(input)).toEqual({ ok: true, out: cut, detail: "" });
  expect((await parentCut({ ...input, requested: root })).ok).toBe(false);
  expect((await parentCut({ ...input, requested: cut })).out).toBe(cut);
  expect((await parentCut({ ...input, branch: "unrecorded", requested: cut })).ok).toBe(false);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(replacement);
});
