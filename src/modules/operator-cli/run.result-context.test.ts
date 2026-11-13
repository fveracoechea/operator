import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ErrAsync, OkAsync } from "unthrown";
import { registerTestDevice } from "../../../tools/device-fixture.ts";
import { Environment } from "../environment/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { ReviewRequests } from "../review-requests/main.ts";
import { OperatorCli } from "./main.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-result-context-"));
  await registerTestDevice(root);
  spyOn(Environment, "read").mockReturnValue(
    Environment.parse({
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    }),
  );
});
afterEach(async () => {
  mock.restore();
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

test("CLI preserves next and checked state on success", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  spyOn(ReviewRequests, "next").mockReturnValue(
    OkAsync({
      reason: "review_next",
      data: { requests: [] },
      next: { command: "operator review wait", why: "Wait for a review request." },
      state: { requests: 0 },
    }),
  );
  await OperatorCli.main(["review", "next", "--json"]);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    outcome: "completed",
    next: { command: "operator review wait", why: "Wait for a review request." },
    state: { requests: 0 },
  });
  expect(error).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

test.each([
  { next: { command: "operator next\n--wait", why: "Wait." }, line: "next: operator next --wait" },
  {
    next: { decider: "person", question: "Delete\r\nretained work?" },
    line: "next: person decides: Delete retained work?",
  },
  {
    next: { decider: "super-agent", question: "Accept the report?" },
    line: "next: super-agent decides: Accept the report?",
  },
] as const)("CLI renders a refusal next step in one line: $line", async ({ next, line }) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  spyOn(WorkSources, "reset").mockReturnValue(
    ErrAsync({
      reason: "source_ended",
      detail: "Already finished.\nNothing changed.",
      next,
    }),
  );
  await OperatorCli.main(["source", "reset", "--source", "s", "--person-instructed"]);
  expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
    "operator: source_ended: Already finished. Nothing changed.",
    line,
  ]);
  expect(log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(3);
});
