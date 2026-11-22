import { eq } from "drizzle-orm";
import { Err, Ok, fromThrowable, type Result } from "unthrown";
import { z } from "zod";
import { PrStacks } from "../pr-stacks/main.ts";
import type { Refusal } from "../../lib/cli-result.ts";
import type { Db } from "./database.ts";
import { assignments, promotions, sources, stackBases, stackOperations } from "./schema.ts";
import { corruptStack, stackParse } from "./stack-records.ts";

type Change = {
  operation?: typeof stackOperations.$inferSelect;
  base?: typeof stackBases.$inferSelect;
};
const planGraph = z.object({
  assignments: z.array(
    z.object({
      key: z.string(),
      dependencies: z.array(z.string()),
    }),
  ),
});

function acyclic(graph: Map<string, Set<string>>) {
  for (const key of graph.keys()) {
    const seen = new Set<string>();
    const pending = [...(graph.get(key) ?? [])];
    while (pending.length > 0) {
      const parent = pending.pop();
      if (parent === key) return false;
      if (parent === undefined || seen.has(parent)) continue;
      if (!graph.has(parent)) return false;
      seen.add(parent);
      pending.push(...(graph.get(parent) ?? []));
    }
  }
  return true;
}

/** The immediate writer reservation covers both the graph read and proposed edge admission. */
export function stackGraph(db: Db, sourceId: string, change: Change): Result<void, Refusal> {
  return fromThrowable(() => {
    const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
    if (source === undefined) return corruptStack();
    const graph = new Map(
      db
        .select()
        .from(assignments)
        .where(eq(assignments.sourceId, sourceId))
        .all()
        .map((row) => [row.key, new Set<string>()]),
    );
    const registered = planGraph.parse(JSON.parse(source.plan)).assignments;
    const promoted = db
      .select()
      .from(promotions)
      .where(eq(promotions.sourceId, sourceId))
      .all()
      .map((row) => ({ key: row.assignment, dependencies: [row.report] }));
    for (const row of [...registered, ...promoted]) {
      const edges = graph.get(row.key);
      if (edges === undefined) return corruptStack();
      for (const parent of row.dependencies) edges.add(parent);
    }
    const bases = db
      .select()
      .from(stackBases)
      .where(eq(stackBases.sourceId, sourceId))
      .all()
      .filter((row) => row.assignment !== change.base?.assignment);
    if (change.base !== undefined) bases.push(change.base);
    const operations = db
      .select()
      .from(stackOperations)
      .where(eq(stackOperations.sourceId, sourceId))
      .all()
      .filter((row) => row.id !== change.operation?.id);
    if (change.operation !== undefined) operations.push(change.operation);
    const bindings = [
      ...bases.map((row) => ({
        assignment: row.assignment,
        parents: PrStacks.decode(row.data).parents,
      })),
      ...operations
        .filter((row) => row.state !== "cancelled")
        .map((row) => ({
          assignment: row.assignment,
          parents: PrStacks.operation(row.data).parents,
        })),
    ];
    for (const row of bindings) {
      const edges = graph.get(row.assignment);
      if (edges === undefined) return corruptStack();
      for (const parent of row.parents) edges.add(parent.assignment);
    }
    return acyclic(graph)
      ? Ok(undefined)
      : Err<Refusal>({
          reason: "stack_parent",
          detail:
            "The proposed prerequisites create an assignment cycle or reference missing work. Nothing was stored.",
          next: {
            command: "operator pr stack plan",
            why: "Choose implemented, acyclic prerequisites from this source.",
          },
        });
  }, stackParse)().flatMap((result) => result);
}
