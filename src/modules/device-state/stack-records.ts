import { and, eq } from "drizzle-orm";
import { Err, Ok, fromThrowable, type Result } from "unthrown";
import { z } from "zod";
import { PrStacks } from "../pr-stacks/main.ts";
import type { Refusal } from "../../lib/cli-result.ts";
import type { Db } from "./database.ts";
import { launches, pullRequests, sources, stackOperations } from "./schema.ts";
import { stackHistory } from "./stack-history.ts";

type Row = typeof stackOperations.$inferSelect;
type Plan = ReturnType<typeof PrStacks.operation>;

function corruptStackFailure(): Refusal {
  return {
    reason: "state_corrupt",
    detail: "The stored stack identity or provenance is invalid. It was not changed.",
    next: {
      decider: "person",
      question: "How should the damaged stack evidence be inspected without overwriting it?",
    },
  };
}

export function corruptStack() {
  return Err(corruptStackFailure());
}

export function stackParse<C, T>(cause: C, defect: (cause: C) => T) {
  return cause instanceof SyntaxError || cause instanceof z.ZodError
    ? corruptStackFailure()
    : defect(cause);
}

function lineageValid(db: Db, row: Row, plan: Plan, launch: typeof launches.$inferSelect) {
  const ids = [...plan.previousOwners, row.launchId];
  if (new Set(ids).size !== ids.length) return false;
  let attempt = -1;
  for (const id of ids) {
    const owner = db.select().from(launches).where(eq(launches.id, id)).get();
    if (
      owner === undefined ||
      owner.sourceId !== row.sourceId ||
      owner.assignment !== row.assignment ||
      owner.branch !== plan.branch ||
      owner.worktreePath !== launch.worktreePath ||
      owner.attempt <= attempt
    )
      return false;
    attempt = owner.attempt;
  }
  return true;
}

function parentsValid(db: Db, row: Row, plan: Plan) {
  if (new Set(plan.parents.map((parent) => parent.assignment)).size !== plan.parents.length)
    return false;
  return plan.parents.every((parent) => {
    const pr = db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.sourceId, row.sourceId),
          eq(pullRequests.assignment, parent.assignment),
        ),
      )
      .get();
    return (
      parent.assignment !== row.assignment &&
      pr?.number === parent.number &&
      pr.branch === parent.branch &&
      pr.repository === plan.repository
    );
  });
}

/** Shape alone cannot authorize a stored PR number, launch lineage, or branch effect. */
export function stackRecord(db: Db, row: Row): Result<Plan, Refusal> {
  return fromThrowable(() => {
    const plan = PrStacks.operation(row.data);
    const source = db.select().from(sources).where(eq(sources.id, row.sourceId)).get();
    const launch = db.select().from(launches).where(eq(launches.id, row.launchId)).get();
    const pr = db
      .select()
      .from(pullRequests)
      .where(
        and(eq(pullRequests.sourceId, row.sourceId), eq(pullRequests.assignment, row.assignment)),
      )
      .get();
    if (
      !rowMatches(row, plan) ||
      source?.repository !== plan.repository ||
      launch === undefined ||
      !ownerMatches(row, plan, launch, pr) ||
      !lineageValid(db, row, plan, launch) ||
      !parentsValid(db, row, plan)
    )
      return corruptStack();
    if (row.reviewHistory !== null) {
      const history = stackHistory(row.reviewHistory);
      if ("operation" in history && history.operation !== row.id) return corruptStack();
    }
    return Ok(plan);
  }, stackParse)().flatMap((result) => result);
}

function rowMatches(row: Row, plan: Plan) {
  const state = ["complete", "cancelled"].includes(plan.step)
    ? plan.step
    : plan.blocker === null
      ? "planned"
      : "blocked";
  return (
    row.id === plan.id &&
    row.sourceId === plan.sourceId &&
    row.assignment === plan.assignment &&
    row.launchId === plan.launchId &&
    row.state === state &&
    Number.isInteger(row.revision) &&
    row.revision > 0
  );
}

function ownerMatches(
  row: Row,
  plan: Plan,
  launch: typeof launches.$inferSelect,
  pr: typeof pullRequests.$inferSelect | undefined,
) {
  return (
    pr?.number === plan.number &&
    pr.branch === plan.branch &&
    pr.repository === plan.repository &&
    launch.sourceId === row.sourceId &&
    launch.assignment === row.assignment &&
    launch.branch === plan.branch &&
    (plan.worktree === undefined || plan.worktree === launch.worktreePath) &&
    (plan.originalRef === undefined ||
      plan.originalRef === `refs/operator/stacks/${plan.id}/original`)
  );
}
