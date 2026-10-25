import type { Database } from "bun:sqlite";
import * as model from "../state-machines/assignment/model.ts";
import { decide } from "../state-machines/assignment/table.ts";
import { err, ok, type OperationError, type Receipt, type Result } from "./model.mts";
import { read, transaction, write } from "./store.mts";
import { refusal, type OwnerError } from "./owner-errors.mts";

export const Assignment = {
  step(input: {
    db: Database;
    revision: number;
    event: model.Event;
    facts: model.Facts;
    failAfterWrite?: boolean;
  }) {
    return transaction(input.db, (): Result<model.Decision & { revision: number }, OwnerError> => {
      const record = read(input.db);
      if (record.revision !== input.revision) return err(refusal("stale-revision"));
      const state = model.stateSchema.parse(record.state);
      const decision = decide({ state, event: input.event, facts: input.facts });
      if (decision.status === "refused") return err(refusal(decision.reason));
      write(input.db, decision.state);
      if (input.failAfterWrite)
        return err({
          type: "store",
          code: "injected",
          cause: { name: "ControlledFailure", message: "Failure after state write" },
        } satisfies OwnerError);
      return ok({ ...decision, revision: record.revision + 1 });
    });
  },
  result(input: {
    db: Database;
    revision: number;
    key: string;
    facts: model.Facts;
    result: Result<Receipt, OperationError>;
  }) {
    const outcome = input.result.ok
      ? "done"
      : input.result.error.evidence === "not-applied"
        ? "not-applied"
        : "unknown";
    return Assignment.step({ ...input, event: { type: "result", key: input.key, outcome } });
  },
};
