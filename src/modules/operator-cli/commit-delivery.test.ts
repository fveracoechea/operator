import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, OkAsync } from "unthrown";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { CommitDelivery } from "../commit-delivery/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
import { runCommitDelivery } from "./commit-delivery.ts";
import { DeviceState } from "../device-state/main.ts";

const paths = OperatorHome.resolve(
  Environment.parse({
    HOME: "/isolated",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
  }),
);
let root = "";
afterEach(async () => {
  mock.restore();
  process.exitCode = 0;
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});

test("malformed commit commands invoke no workflow effects", async () => {
  const review = spyOn(CommitDelivery, "review");
  const round = spyOn(CommitDelivery, "round");
  const deliver = spyOn(CommitDelivery, "deliver");
  for (const args of [
    ["pr", "review"],
    ["commit"],
    ["commit", "deliver"],
    ["commit", "round", "--file"],
    ["commit", "review", "--file", "x"],
    ["commit", "round", "--unknown", "x"],
    ["commit", "round", "--file", "x", "--source", "s"],
  ])
    expect(await runCommitDelivery(args, paths, true)).toBe(false);
  expect(review).not.toHaveBeenCalled();
  expect(round).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
});

test("a review refusal is returned without launching a handoff", async () => {
  const review = spyOn(CommitDelivery, "review").mockReturnValue(
    ErrAsync({
      reason: "commit_worktree_unclean",
      detail: "Keep personal changes.",
      next: { command: "operator next", why: "Read current work." },
    }),
  );
  const handoff = spyOn(PullRequests, "startKindHandoff");
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(await runCommitDelivery(["commit", "review", "--json"], paths, true)).toBe(true);
  expect(review).toHaveBeenCalledWith({ paths, cwd: process.cwd() });
  expect(handoff).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "commit_review",
    reason: "commit_worktree_unclean",
  });
  expect(process.exitCode).not.toBe(0);
});

test.each(["round", "deliver"])(
  "%s reads the supplied file and returns the matching result envelope",
  async (command) => {
    root = await mkdtemp("/tmp/opencode/commit-command-");
    const file = `${root}/input.md`;
    await Bun.write(file, "recorded input\n");
    const data = DeviceState.commitDeliverySchema().parse({
      repository: "o/r",
      ticket: "#411",
      checkout: "/repo",
      localRef: "refs/heads/main",
      remoteRef: "refs/heads/main",
      remote: "https://github.com/o/r.git",
      base: "a".repeat(40),
      publishedHead: null,
      policy: { checks: [["git", "status"]], review: "required", publication: "local-and-origin" },
      candidate: null,
      history: [],
      implementer: null,
      rounds: [],
      dispositions: [],
      checks: null,
      journal: [],
      stage: "build",
      ownerPid: null,
      leaseAt: null,
    });
    const round = spyOn(CommitDelivery, "round").mockReturnValue(OkAsync(data));
    const deliver = spyOn(CommitDelivery, "deliver").mockReturnValue(OkAsync(data));
    const log = spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    expect(
      await runCommitDelivery(["commit", command, "--file", file, "--json"], paths, true),
    ).toBe(true);
    const called = command === "round" ? round : deliver;
    const other = command === "round" ? deliver : round;
    expect(called).toHaveBeenCalledWith({ paths, cwd: process.cwd(), text: "recorded input\n" });
    expect(other).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      operation: `commit_${command}`,
      reason: command === "round" ? "commit_round_recorded" : "commit_delivered",
      data,
    });
  },
);

test("an unreadable input is a refusal before any commit operation", async () => {
  const round = spyOn(CommitDelivery, "round");
  const deliver = spyOn(CommitDelivery, "deliver");
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(
    await runCommitDelivery(
      ["commit", "round", "--file", "/nonexistent/commit-input.md"],
      paths,
      true,
    ),
  ).toBe(true);
  expect(round).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "commit_round",
    reason: "commit_input_invalid",
    next: { command: "operator --help", why: "Supply a readable markdown file." },
  });
});
