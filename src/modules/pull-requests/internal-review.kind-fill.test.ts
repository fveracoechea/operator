import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { dispatch } from "./internal-review.ts";
import { prDevice } from "./device-fixture.ts";

afterEach(() => mock.restore());

test.each([
  ["migration", "kind"],
  ["ordinary", "kind"],
  ["migration", "supervisor"],
  ["ordinary", "supervisor"],
] as const)(
  "a %s parking resume refuses a racing %s change without further writes",
  async (origin, race) => {
    await using device = await prDevice({ assignments: ["parent"] });
    const started = device.start("parent");
    device.associate(started.launchId, 7, "task/parent", null, {
      head: "h",
      at: "then",
      note: null,
      dispositions: [],
    });
    using db = new Database(device.paths.database);
    db.exec(
      "UPDATE launches SET state = 'finished'; UPDATE sources SET supervising_session = 'own'",
    );
    db.query("UPDATE assignments SET kind = ?").run(race === "kind" ? null : "pr-feedback");
    const migration =
      origin === "migration" ? { origin: "migration-0026", head: null } : { head: "h" };
    const parking = JSON.stringify({
      ...migration,
      launchId: started.launchId,
      at: "then",
      note: null,
      state: "parked",
      events: ['{"kind":"feedback"}'],
    });
    db.query("UPDATE pull_requests SET parking = ?").run(parking);
    db.exec("UPDATE kind_handoffs SET handoff_state = 'done', owner_pid = NULL, lease_at = NULL");
    const handoffs = db.query("SELECT * FROM kind_handoffs").all();
    spyOn(Environment, "caller").mockReturnValue({ pane: "own:p", session: "own" });
    let before = db.serialize();
    const show = WorkSources.show;
    const read = spyOn(WorkSources, "show").mockImplementation((input) =>
      show(input).tap(() => {
        db.exec(
          race === "kind"
            ? "UPDATE assignments SET kind = 'pr-feedback'"
            : "UPDATE sources SET supervising_session = 'foreign'",
        );
        before = db.serialize();
      }),
    );
    const launched = spyOn(WorkerDispatch, "dispatch");
    const checked = spyOn(WorkerDispatch, "checkHandoff");
    const closed = spyOn(Herdr, "closePane");
    const result = await dispatch({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      ...(race === "kind" ? { kind: "implementation" } : {}),
    });
    expect(result).toMatchObject({
      tag: "Err",
      error: { reason: race === "kind" ? "assignment_kind_set" : "source_supervised_elsewhere" },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(db.serialize()).toEqual(before);
    expect(db.query("SELECT parking FROM pull_requests").get()).toEqual({ parking });
    expect(db.query("SELECT * FROM kind_handoffs").all()).toEqual(handoffs);
    expect(launched).not.toHaveBeenCalled();
    expect(checked).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(device.calls).toEqual([]);
  },
);
