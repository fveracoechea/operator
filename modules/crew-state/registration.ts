import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { insertAssignment, nextOrderIndex } from "./assignment.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import { assignmentId, identityOf } from "./identity.ts";
import { assignmentDependencies, assignments, workSources } from "./schema.ts";
import {
  isExecutable,
  kindOf,
  storedFixedInputs,
  storedPermissions,
  type WorkInput,
} from "./work-input.ts";
import { overlappingPaths, overlapsCommand } from "./write-paths.ts";

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

/** Two items of one source whose write paths overlap and that no dependency orders. */
export type WritePathOverlap = {
  sourceKeys: [string, string];
  paths: Array<[string, string]>;
};

/**
 * What a registration says about its overlaps. The Operator reads the registration report, so
 * the report gives only the count and the items, and `findOverlaps` gives each pair on request.
 */
export type OverlapSummary = { pairCount: number; sourceKeys: string[]; command: string };

export type RegisterResult =
  | {
      status: "registered";
      source: { id: string; kind: string; revision: string; orderIndex: number };
      registered: RegisteredAssignment[];
      existing: RegisteredAssignment[];
      overlaps: OverlapSummary;
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
  | { status: "dependency-cycle"; cycle: string[] }
  | {
      status: "fixed-inputs-changed";
      sourceKey: string;
      assignmentId: string;
      // Only the names of the inputs that differ, so the refusal stays short for its reader.
      changed: string[];
    }
  | {
      status: "fixed-input-mismatch";
      sourceKey: string;
      name: string;
      path: string;
      statedIdentity: string;
      foundIdentity: string | null;
    };

/** The identity of each file a path input names, or null when the checkout does not hold it. */
export type FoundIdentities = Map<string, string | null>;

/** Reads every file the path inputs of one request name, before the state transaction opens. */
export async function readPathIdentities(
  projectRoot: string,
  input: WorkInput,
): Promise<FoundIdentities> {
  const found: FoundIdentities = new Map();
  for (const item of input.items) {
    for (const one of item.fixedInputs) {
      if (one.kind !== "path" || found.has(one.value)) {
        continue;
      }
      const file = Bun.file(`${projectRoot}/${one.value}`);
      found.set(
        one.value,
        (await file.exists()) ? ContentIdentity.ofBytes(await file.bytes()) : null,
      );
    }
  }
  return found;
}

/** The names whose input was added, removed, or changed between the record and the request. */
function changedInputNames(
  recorded: WorkInput["items"][number]["fixedInputs"],
  requested: WorkInput["items"][number]["fixedInputs"],
): string[] {
  const names = new Set([...recorded, ...requested].map((one) => one.name));
  return [...names]
    .filter(
      (name) =>
        identityOf(recorded.filter((one) => one.name === name)) !==
        identityOf(requested.filter((one) => one.name === name)),
    )
    .toSorted();
}

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

/** Every recorded dependency, by the assignment that waits. */
function dependencyEdges(db: CrewReader): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const row of db.select().from(assignmentDependencies).all()) {
    edges.set(
      row.assignmentId,
      [...(edges.get(row.assignmentId) ?? []), row.dependsOnId].toSorted(),
    );
  }
  return edges;
}

/** Whether a chain of dependencies leads from one assignment to another. */
function reaches(edges: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const pending = [from];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === to) {
      return true;
    }
    if (!seen.has(node)) {
      seen.add(node);
      pending.push(...(edges.get(node) ?? []));
    }
  }
  return false;
}

/**
 * Each pair of production items in one source whose registered write paths overlap and that no
 * dependency orders, in item order. A pair that a dependency orders never runs at the same time,
 * so it is not reported. The paths of a pair stay in the order each item registered them.
 */
function findOverlaps(db: CrewReader, sourceId: string): WritePathOverlap[] {
  const edges = dependencyEdges(db);
  const production = db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, sourceId))
    .all()
    .filter((row) => row.kind === "production")
    .toSorted((one, other) => one.orderIndex - other.orderIndex)
    .map((row) => ({ row, writePaths: storedPermissions(row.permissions).writePaths }));

  return production.flatMap((one, index) =>
    production.slice(index + 1).flatMap((other): WritePathOverlap[] => {
      if (reaches(edges, one.row.id, other.row.id) || reaches(edges, other.row.id, one.row.id)) {
        return [];
      }
      const paths = overlappingPaths(one.writePaths, other.writePaths);
      return paths.length === 0
        ? []
        : [{ sourceKeys: [one.row.sourceKey, other.row.sourceKey], paths }];
    }),
  );
}

/** The count of pairs and each item in one, in item order. */
function summarize(
  sourceId: string,
  overlaps: WritePathOverlap[],
  items: RegisteredAssignment[],
): OverlapSummary {
  const involved = new Set(overlaps.flatMap((one) => one.sourceKeys));
  return {
    pairCount: overlaps.length,
    sourceKeys: items
      .filter((one) => involved.has(one.sourceKey))
      .toSorted((one, other) => one.orderIndex - other.orderIndex)
      .map((one) => one.sourceKey),
    command: overlapsCommand(sourceId),
  };
}

export function registerWork(
  db: CrewWriter,
  request: { input: WorkInput; found: FoundIdentities; now: string },
): RegisterResult {
  const { input, found, now } = request;
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
      // An item keeps the inputs it was registered with, so a changed one needs a decision.
      if (identityOf(item.fixedInputs) !== recorded.fixedInputsIdentity) {
        return {
          status: "fixed-inputs-changed",
          sourceKey: item.key,
          assignmentId: id,
          changed: changedInputNames(storedFixedInputs(recorded.fixedInputs), item.fixedInputs),
        };
      }
      existing.push(reported(recorded));
      continue;
    }

    // A path input is fixed by the identity of the file the checkout holds now, not by a claim.
    for (const one of item.fixedInputs) {
      if (one.kind !== "path") {
        continue;
      }
      const foundIdentity = found.get(one.value) ?? null;
      if (one.contentIdentity !== foundIdentity) {
        return {
          status: "fixed-input-mismatch",
          sourceKey: item.key,
          name: one.name,
          path: one.value,
          statedIdentity: one.contentIdentity,
          foundIdentity,
        };
      }
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

  const cycle = findCycle(dependencyEdges(db));
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
    overlaps: summarize(source.id, findOverlaps(db, source.id), registered.concat(existing)),
  };
}

/** Each overlapping pair of one registered source, or a refusal when the source is unknown. */
export function showOverlaps(db: CrewReader, sourceId: string) {
  return db.select().from(workSources).where(eq(workSources.id, sourceId)).all().length === 0
    ? { status: "unknown-source" as const, sourceId }
    : { status: "reported" as const, sourceId, overlaps: findOverlaps(db, sourceId) };
}
