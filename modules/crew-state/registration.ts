import { eq } from "drizzle-orm";
import type { CrewWriter } from "./database.ts";
import { insertAssignment, nextOrderIndex } from "./assignment.ts";
import { assignmentId } from "./identity.ts";
import { assignmentDependencies, assignments, workSources } from "./schema.ts";
import { isExecutable, kindOf, type WorkInput } from "./work-input.ts";

export type RegisteredAssignment = {
  assignmentId: string;
  sourceKey: string;
  title: string;
  kind: string;
  executable: boolean;
  orderIndex: number;
  revision: number;
  state: string;
};

export type RegisterResult =
  | {
      status: "registered";
      source: { id: string; kind: string; revision: string; orderIndex: number };
      registered: RegisteredAssignment[];
      existing: RegisteredAssignment[];
    }
  | {
      status: "source-revision-changed";
      sourceId: string;
      recordedRevision: string;
      requestedRevision: string;
      fixedAssignments: string[];
    }
  | {
      status: "unknown-dependency";
      sourceKey: string;
      dependency: { sourceId: string; key: string };
    }
  | {
      status: "dependencies-changed";
      sourceKey: string;
      assignmentId: string;
      recorded: string[];
      requested: string[];
    }
  | { status: "dependency-cycle"; cycle: string[] };

function reported(row: typeof assignments.$inferSelect): RegisteredAssignment {
  return {
    assignmentId: row.id,
    sourceKey: row.sourceKey,
    title: row.title,
    kind: row.kind,
    executable: isExecutable(row.kind),
    orderIndex: row.orderIndex,
    revision: row.revision,
    state: row.state,
  };
}

/** Finds one dependency cycle, so a registration that would deadlock dispatch is refused. */
function findCycle(edges: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];

  function walk(node: string): string[] | null {
    if (done.has(node)) {
      return null;
    }
    if (visiting.has(node)) {
      return [...path.slice(path.indexOf(node)), node];
    }

    visiting.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle !== null) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(node);
    done.add(node);
    return null;
  }

  for (const node of [...edges.keys()].toSorted()) {
    const cycle = walk(node);
    if (cycle !== null) {
      return cycle;
    }
  }

  return null;
}

export function registerWork(
  db: CrewWriter,
  request: { input: WorkInput; now: string },
): RegisterResult {
  const { input, now } = request;
  const recordedSource = db
    .select()
    .from(workSources)
    .where(eq(workSources.id, input.source.id))
    .all()[0];

  if (recordedSource !== undefined && recordedSource.revision !== input.source.revision) {
    return {
      status: "source-revision-changed",
      sourceId: input.source.id,
      recordedRevision: recordedSource.revision,
      requestedRevision: input.source.revision,
      fixedAssignments: db
        .select()
        .from(assignments)
        .where(eq(assignments.sourceId, input.source.id))
        .all()
        .map((row) => row.id),
    };
  }

  if (recordedSource === undefined) {
    db.insert(workSources)
      .values({
        id: input.source.id,
        kind: input.sourceKind,
        revision: input.source.revision,
        tracker: input.source.tracker,
        trackerLocation:
          input.source.location === undefined ? null : JSON.stringify(input.source.location),
        orderIndex: db.select().from(workSources).all().length,
        registeredAt: now,
      })
      .run();
  }

  const source = db.select().from(workSources).where(eq(workSources.id, input.source.id)).all()[0];
  if (source === undefined) {
    throw new Error("the work source row disappeared inside its own transaction");
  }

  const held = db.select().from(assignments).where(eq(assignments.sourceId, source.id)).all();
  const existing: RegisteredAssignment[] = [];
  const registered: RegisteredAssignment[] = [];
  let nextOrder = nextOrderIndex(held);

  for (const item of input.items) {
    const id = assignmentId(source.id, item.key);
    const recorded = held.find((row) => row.id === id);
    if (recorded !== undefined) {
      existing.push(reported(recorded));
      continue;
    }

    const row = insertAssignment(
      db,
      {
        sourceId: source.id,
        sourceKey: item.key,
        sourceRevision: source.revision,
        trackerBinding:
          item.trackerIssue === undefined ? null : JSON.stringify({ issue: item.trackerIssue }),
        title: item.title,
        kind: kindOf(item),
        orderIndex: nextOrder,
        approvedScope: item.approvedScope,
        acceptanceRequirements: item.acceptanceRequirements,
        permissions: item.permissions,
        fixedInputs: item.fixedInputs,
      },
      now,
    );
    nextOrder += 1;
    registered.push(reported(row));
  }

  const newIds = new Set(registered.map((one) => one.assignmentId));
  const known = new Set(
    db
      .select()
      .from(assignments)
      .all()
      .map((row) => row.id),
  );

  // Every item states its dependencies, including an item this request did not create.
  // An item that already exists keeps the edges it was registered with.
  for (const item of input.items) {
    const id = assignmentId(source.id, item.key);
    const requested: string[] = [];

    for (const dependency of item.dependsOn) {
      const dependsOnSource = dependency.sourceId ?? source.id;
      const dependsOnId = assignmentId(dependsOnSource, dependency.key);
      if (!known.has(dependsOnId)) {
        return {
          status: "unknown-dependency",
          sourceKey: item.key,
          dependency: { sourceId: dependsOnSource, key: dependency.key },
        };
      }
      requested.push(dependsOnId);
    }

    if (newIds.has(id)) {
      for (const dependsOnId of requested) {
        db.insert(assignmentDependencies)
          .values({ assignmentId: id, dependsOnId })
          .onConflictDoNothing()
          .run();
      }
      continue;
    }

    const recorded = db
      .select()
      .from(assignmentDependencies)
      .where(eq(assignmentDependencies.assignmentId, id))
      .all()
      .map((edge) => edge.dependsOnId)
      .toSorted();
    const stated = [...new Set(requested)].toSorted();
    if (recorded.join(",") !== stated.join(",")) {
      return {
        status: "dependencies-changed",
        sourceKey: item.key,
        assignmentId: id,
        recorded,
        requested: stated,
      };
    }
  }

  const edges = new Map<string, string[]>();
  for (const row of db.select().from(assignmentDependencies).all()) {
    edges.set(
      row.assignmentId,
      [...(edges.get(row.assignmentId) ?? []), row.dependsOnId].toSorted(),
    );
  }
  const cycle = findCycle(edges);
  if (cycle !== null) {
    return { status: "dependency-cycle", cycle };
  }

  return {
    status: "registered",
    source: {
      id: source.id,
      kind: source.kind,
      revision: source.revision,
      orderIndex: source.orderIndex,
    },
    registered,
    existing,
  };
}
