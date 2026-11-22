import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no synchronous file removal or temporary-directory location API.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Ok } from "unthrown";
import { stackGraph } from "./stack-graph.ts";
import { stackStateFixture, stackFixturePlan } from "./stack-fixture.ts";
import { changeStack } from "./stacks.ts";

test("graph admission includes completed base obligations and pending operations without changing registered dependencies", () => {
  using client = stackStateFixture();
  const db = drizzle(client);
  const left = stackFixturePlan("left", "right");
  const right = stackFixturePlan("right", "left");
  expect(
    changeStack(client, "left", left.id, null, () =>
      Ok({
        data: JSON.stringify(left),
        state: "planned",
        ownerPid: null,
      }),
    ).tag,
  ).toBe("Ok");
  const before = client.serialize();
  expect(
    changeStack(client, "right", right.id, null, () =>
      Ok({
        data: JSON.stringify(right),
        state: "planned",
        ownerPid: null,
      }),
    ),
  ).toMatchObject({ tag: "Err", error: { reason: "stack_parent" } });
  expect(client.serialize()).toEqual(before);
  client.exec("DELETE FROM stack_operations");
  expect(
    stackGraph(db, "source", {
      base: {
        sourceId: "source",
        assignment: "root",
        launchId: "root",
        branch: "task/root",
        data: JSON.stringify({
          head: "h",
          branch: "task/left",
          managed: false,
          parents: right.parents,
        }),
      },
    }),
  ).toMatchObject({ tag: "Err", error: { reason: "stack_parent" } });
});

test("two precomputed reciprocal plans serialize at the writer reservation and the loser cannot admit a cycle", () => {
  using source = stackStateFixture();
  const file = `${tmpdir()}/operator-stack-race-${crypto.randomUUID()}.sqlite`;
  source.exec(`VACUUM INTO '${file}'`);
  try {
    using first = new Database(file);
    using second = new Database(file);
    first.exec("PRAGMA busy_timeout = 0");
    second.exec("PRAGMA busy_timeout = 0");
    const left = stackFixturePlan("left", "right");
    const right = stackFixturePlan("right", "left");
    let raced = false;
    expect(
      changeStack(first, "left", left.id, null, () => {
        expect(
          changeStack(second, "right", right.id, null, () => {
            raced = true;
            return Ok({ data: JSON.stringify(right), state: "planned", ownerPid: null });
          }),
        ).toMatchObject({ tag: "Err", error: { reason: "state_busy" } });
        return Ok({ data: JSON.stringify(left), state: "planned", ownerPid: null });
      }).tag,
    ).toBe("Ok");
    expect(raced).toBe(false);
    const before = first.serialize();
    expect(
      changeStack(second, "right", right.id, null, () =>
        Ok({ data: JSON.stringify(right), state: "planned", ownerPid: null }),
      ),
    ).toMatchObject({ tag: "Err", error: { reason: "stack_parent" } });
    expect(first.serialize()).toEqual(before);
    expect(first.query("SELECT id FROM stack_operations").all()).toEqual([{ id: left.id }]);
  } finally {
    rmSync(file, { force: true });
  }
});
