import type { Database } from "bun:sqlite";
import { read, write } from "../store.ts";
import { inspect, stateSchema, type Event, type Facts } from "./model.ts";
import { decide as reducer } from "./reducer.ts";
import { decide as table } from "./table.ts";

export const AssignmentPrototype = {
  run(input: {
    db: Database;
    revision: number;
    event: Event;
    facts: Facts;
    design: "reducer" | "table";
  }) {
    const { db, revision, event, facts, design } = input;
    const decide = design === "table" ? table : reducer;
    return db
      .transaction(() => {
        const record = read(db);
        const state = stateSchema.parse(record.state);
        const decision =
          record.revision === revision
            ? decide({ state, event, facts })
            : ({
                status: "refused",
                reason: "stale-revision",
                state,
                effects: [],
              } satisfies ReturnType<typeof decide>);
        if (decision.status === "changed") write(db, decision.state);
        return {
          ...decision,
          revision: record.revision + Number(decision.status === "changed"),
          ...inspect(decide, decision.state, facts),
        };
      })
      .immediate();
  },
};
