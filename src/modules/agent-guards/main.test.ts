import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, Ok } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { AgentGuards } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "agent-guards-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
const session = { paths, cwd: "/checkout", session: "ses-1" };
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a commit with a Co-Authored-By trailer gets a reason that names the fix", async () => {
  expect(
    await AgentGuards.commit({
      command: 'git commit -m "fix: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
      cwd: root,
    }),
  ).toMatchObject({
    tag: "Ok",
    value: expect.stringMatching(/Co-Authored-By.*commit again/s) as string,
  });
});

test("a commit without the trailer, or another command, has no opinion", async () => {
  for (const command of ['git commit -m "fix: x"', "ls", 'echo "Co-Authored-By: A"'])
    expect(await AgentGuards.commit({ command, cwd: root })).toMatchObject({
      tag: "Ok",
      value: null,
    });
});

test("unwatched running work keeps the turn going and names the background wait", async () => {
  const unwatched = spyOn(WorkSources, "unwatched").mockReturnValue(Ok(["one", "two"]));
  const result = await AgentGuards.turnEnd(session);
  expect(unwatched).toHaveBeenCalledWith(session);
  expect(result).toMatchObject({
    tag: "Ok",
    value: expect.stringMatching(
      /This session supervises running work in one, two.*operator next --wait --json as a background command/s,
    ) as string,
  });
});

test("watched or no running work lets the turn end", async () => {
  spyOn(WorkSources, "unwatched").mockReturnValue(Ok([]));
  expect(await AgentGuards.turnEnd(session)).toMatchObject({ tag: "Ok", value: null });
});

test("missing, blocked, or unreadable state lets the turn end", async () => {
  const unwatched = spyOn(WorkSources, "unwatched");
  for (const reason of [
    "state_missing",
    "state_incompatible",
    "state_busy",
    "state_corrupt",
  ] as const) {
    unwatched.mockReturnValueOnce(Err({ reason, detail: "unusable" }));
    expect(await AgentGuards.turnEnd(session)).toMatchObject({ tag: "Ok", value: null });
  }
});

test("a defect stays a defect, so the host hook fails and lets the turn end", async () => {
  spyOn(WorkSources, "unwatched").mockReturnValue(
    Ok([]).map(() => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the public module boundary.
      throw new Error("broken");
    }),
  );
  expect(await AgentGuards.turnEnd(session)).toMatchObject({ tag: "Defect" });
});
