import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";
import { actionKeys } from "./coordination.ts";
import { storedObligation, storedSource } from "./source-fixture.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-source-obligations-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function read(row: ReturnType<typeof storedSource>) {
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
  spyOn(DeviceState, "readSources").mockReturnValue(Ok([row]));
  return WorkSources.next({ paths, cwd: root });
}

async function next(row: ReturnType<typeof storedSource>) {
  const result = await read(row);
  return result.tag === "Ok" ? result.value.sources[0] : expect.unreachable("next refused");
}

const rule = storedObligation("dev-trane", {
  kind: "standing-rule",
  summary: "Only use dev:trane.",
  openedAt: "2026-01-02T00:00:00.000Z",
});

test("next shows each open obligation of a source in the order it was opened", async () => {
  const source = await next(
    storedSource([{ key: "read", completion: "report", state: "ready" }], {
      obligations: [
        rule,
        storedObligation("share-12", { reference: "https://github.com/example/one/pull/12" }),
        storedObligation("share-11", { state: "closed", closedAt: "2026-01-04T00:00:00.000Z" }),
      ],
    }),
  );
  expect(source?.owed).toEqual([
    {
      key: "dev-trane",
      kind: "standing-rule",
      summary: "Only use dev:trane.",
      reference: null,
      openedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      key: "share-12",
      kind: "pr-share",
      summary: "Share share-12 in the review thread.",
      reference: "https://github.com/example/one/pull/12",
      openedAt: "2026-01-03T00:00:00.000Z",
    },
  ]);
});

test("an ended source keeps showing what is still owed", async () => {
  const source = await next(
    storedSource([{ key: "read", completion: "report", state: "completed" }], {
      state: "finished",
      endedAt: "2026-01-05T00:00:00.000Z",
      obligations: [storedObligation("share-12")],
    }),
  );
  expect(source?.owed).toMatchObject([{ key: "share-12" }]);
});

test("an obligation is not an action, so opening or closing one wakes no coordination wait", async () => {
  const planned = [{ key: "read", completion: "report" as const, state: "ready" }];
  const without = await read(storedSource(planned));
  mock.restore();
  const owed = await read(storedSource(planned, { obligations: [rule] }));
  expect(without.tag === "Ok" && owed.tag === "Ok").toBe(true);
  if (without.tag === "Ok" && owed.tag === "Ok")
    expect(actionKeys(owed.value)).toEqual(actionKeys(without.value));
});

test("a stored obligation with an unknown kind or a closed one without its end is corruption", async () => {
  for (const row of [
    storedObligation("share-12", { kind: "promise" }),
    storedObligation("share-12", { state: "closed" }),
    storedObligation("share-12", { closedAt: "2026-01-04T00:00:00.000Z" }),
  ])
    expect(
      await read(
        storedSource([{ key: "read", completion: "report", state: "ready" }], {
          obligations: [row],
        }),
      ),
    ).toMatchObject({ error: { reason: "state_corrupt" } });
});
