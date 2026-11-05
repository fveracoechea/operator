import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok } from "unthrown";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { turnEnd } from "./turn-end.ts";

const paths = OperatorHome.resolve(Environment.parse({ HOME: "/isolated/turn", NODE_ENV: "test" }));
const stop = { paths, cwd: "/checkout", stop_hook_active: false };
afterEach(() => {
  mock.restore();
});

function pane(id: string | undefined) {
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), HERDR_PANE_ID: id });
}

test("unwatched running work blocks the turn's end and names the background wait", async () => {
  pane("pane-1");
  const unwatched = spyOn(WorkSources, "unwatched").mockReturnValue(Ok(["one", "two"]));
  const result = await turnEnd(stop);
  expect(unwatched).toHaveBeenCalledWith({ paths, cwd: "/checkout", paneId: "pane-1" });
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  const answer = z
    .strictObject({ decision: z.literal("block"), reason: z.string() })
    .parse(JSON.parse(result.value));
  expect(answer.reason).toContain("running work in one, two");
  expect(answer.reason).toContain("operator next --wait --json as a background command");
});

test("watched or no running work lets the turn end", async () => {
  pane("pane-1");
  spyOn(WorkSources, "unwatched").mockReturnValue(Ok([]));
  expect(await turnEnd(stop)).toMatchObject({ tag: "Ok", value: "" });
});

test("a turn that a block already continued ends, so the guard blocks at most once in a row", async () => {
  pane("pane-1");
  const unwatched = spyOn(WorkSources, "unwatched").mockReturnValue(Ok(["one"]));
  expect(await turnEnd({ ...stop, stop_hook_active: true })).toMatchObject({
    tag: "Ok",
    value: "",
  });
  expect(unwatched).not.toHaveBeenCalled();
});

test("an agent outside a Herdr pane supervises nothing", async () => {
  pane(undefined);
  const unwatched = spyOn(WorkSources, "unwatched");
  expect(await turnEnd(stop)).toMatchObject({ tag: "Ok", value: "" });
  expect(unwatched).not.toHaveBeenCalled();
});

test("missing, blocked, or unreadable state lets the turn end", async () => {
  pane("pane-1");
  const unwatched = spyOn(WorkSources, "unwatched");
  for (const reason of [
    "state_missing",
    "state_incompatible",
    "state_busy",
    "state_corrupt",
  ] as const) {
    unwatched.mockReturnValueOnce(Err({ reason, detail: "unusable" }));
    expect(await turnEnd(stop)).toMatchObject({ tag: "Ok", value: "" });
  }
});

test("a defect stays a defect, so the hook exits 1 and Claude Code lets the turn end", async () => {
  pane("pane-1");
  spyOn(WorkSources, "unwatched").mockReturnValue(
    Ok([]).map(() => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the public module boundary.
      throw new Error("broken");
    }),
  );
  expect(await turnEnd(stop)).toMatchObject({ tag: "Defect" });
});
