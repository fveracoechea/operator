// Bun has no real-path API.
import { realpath } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { insertAssignment } from "./assignment.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import { assignmentId, identityOf } from "./identity.ts";
import { assignmentDependencies, assignments, workSources } from "./schema.ts";
import {
  type CanonicalRead,
  canonicalRead,
  keyOf,
  type ReadGap,
  type ReadItem,
  type SourceRead,
  textIdentity,
} from "./source-read.ts";
import {
  type AssignmentKind,
  isExecutable,
  kindOfWayfinderType,
  type PlanningType,
  planningTypeOf,
  storedPermissions,
  storedTrackerBinding,
  storedTrackerLocation,
  type WorkInput,
  type WorkItem,
} from "./work-input.ts";
import { writePathsReader } from "./write-path-grants.ts";
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

/** One item the registration would record, in item order. */
export type PlannedItem = {
  key: string;
  issueId: number;
  position: number;
  title: string;
  kind: AssignmentKind;
  // The wayfinder type of planning work, which decides the authority of its decisions.
  planningType: PlanningType | null;
  executable: boolean;
  change: "new";
  dependsOn: Array<{ sourceId: string; key: string }>;
};

/** A blocker that gates nothing, because its issue is closed. */
export type SatisfiedBlocker = { key: string; blocker: string };

/**
 * One reason the registration refuses. Every refusal of one read is reported at once: the
 * source first, then each item in item order with its blockers by key, then the input.
 */
export type Refusal =
  | { reason: "source_not_found"; key: string }
  | { reason: "tracker_read_incomplete"; key: string; list: string; detail: string }
  | { reason: "source_without_items"; key: string }
  | { reason: "source_already_registered"; key: string }
  | { reason: "source_recorded_without_parent"; key: string; sourceId: string }
  | { reason: "input_issue_missing"; key: string }
  | { reason: "input_issue_outside_source"; key: string }
  | { reason: "issue_already_registered"; key: string; sourceId: string }
  | { reason: "wayfinder_type_unreadable"; key: string; labels: string[] }
  | { reason: "item_kind_contradicted"; key: string; stated: string; label: string }
  | { reason: "executable_item_in_other_repository"; key: string; repository: string }
  | { reason: "write_paths_required"; key: string }
  | {
      reason: "fixed_input_mismatch";
      key: string;
      name: string;
      path: string;
      statedIdentity: string;
      foundIdentity: string | null;
    }
  | { reason: "blocker_unregistered"; key: string; blocker: string }
  | {
      reason: "blocker_in_other_source";
      key: string;
      blocker: string;
      sourceId: string;
      assignmentId: string;
    }
  | { reason: "dependency_cycle"; key: string; cycle: string[] };

export type RegistrationPlan = {
  source: { id: string; kind: string; revision: string | null; repository: string };
  planRevision: string;
  items: PlannedItem[];
  skipped: Array<{ key: string; position: number }>;
  satisfiedBlockers: SatisfiedBlocker[];
  refusals: Refusal[];
};

/** What one plan revision covers: the canonical read and the input, nothing that changes alone. */
export type PlanBasis = { read: CanonicalRead; input: WorkInput };

export type RegisterResult =
  | {
      status: "registered";
      source: { id: string; kind: string; revision: string; orderIndex: number };
      planRevision: string;
      registered: RegisteredAssignment[];
      overlaps: OverlapSummary;
    }
  | { status: "refused"; plan: RegistrationPlan }
  | {
      status: "plan-revision-changed";
      requested: string;
      found: string;
      differences: PlanDifference[] | null;
    };

/** One part of a read or an input that differs from the plan a revision named. */
export type PlanDifference = {
  part: "source" | "item" | "input";
  key: string;
  change: "added" | "removed" | "changed";
};

/** The identity of each file a path input names, or null when the checkout does not hold it. */
export type FoundIdentities = Map<string, string | null>;

/**
 * Reads every file the path inputs of one request name, before the state transaction opens.
 * A link that leads out of the checkout reads as absent, because the launch reads the file
 * from Git and Git holds only the link.
 */
export async function readPathIdentities(
  projectRoot: string,
  input: WorkInput,
): Promise<FoundIdentities> {
  const found: FoundIdentities = new Map();
  const root = await realpath(projectRoot);
  for (const item of input.items) {
    for (const one of item.fixedInputs) {
      if (one.kind !== "path" || found.has(one.value)) {
        continue;
      }
      const resolved = await realpath(`${projectRoot}/${one.value}`).catch(() => null);
      const inside = resolved !== null && resolved.startsWith(`${root}/`);
      const file = Bun.file(`${projectRoot}/${one.value}`);
      found.set(
        one.value,
        inside && (await file.exists()) ? ContentIdentity.ofBytes(await file.bytes()) : null,
      );
    }
  }
  return found;
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
 * Each pair of production items in one source whose effective write paths overlap and that no
 * dependency orders, in item order. A pair that a dependency orders never runs at the same time,
 * so it is not reported. The frontier hold reads the effective write paths, so a pair that a
 * grant caused is listed too. The paths of a pair stay in the order each item holds them.
 */
function findOverlaps(db: CrewReader, sourceId: string): WritePathOverlap[] {
  const edges = dependencyEdges(db);
  const effectiveOf = writePathsReader(db);
  const production = db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, sourceId))
    .all()
    .filter((row) => row.kind === "production")
    .toSorted((one, other) => one.orderIndex - other.orderIndex)
    .map((row) => ({ row, writePaths: effectiveOf(row) }));

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

/** One registered assignment that a read issue can match. */
type RecordedIssue = { assignmentId: string; sourceId: string; sourceKey: string; kind: string };

type Recorded = {
  sourceIds: Set<string>;
  // A source an earlier release registered has no parent issue, so its map issue names it.
  sourcesWithoutParent: Map<string, string>;
  byIssueId: Map<number, RecordedIssue>;
  // A binding an earlier release recorded holds no database id, so only its key can match.
  byKey: Map<string, RecordedIssue>;
};

function recordedIssues(db: CrewReader): Recorded {
  const recorded: Recorded = {
    sourceIds: new Set(),
    sourcesWithoutParent: new Map(),
    byIssueId: new Map(),
    byKey: new Map(),
  };
  for (const source of db.select().from(workSources).orderBy(workSources.orderIndex).all()) {
    recorded.sourceIds.add(source.id);
    const location =
      source.trackerLocation === null ? null : storedTrackerLocation(source.trackerLocation);
    if (location !== null && location.parent === undefined && location.mapIssue !== null) {
      recorded.sourcesWithoutParent.set(keyOf(location.repository, location.mapIssue), source.id);
    }
  }
  for (const row of db.select().from(assignments).orderBy(assignments.orderIndex).all()) {
    if (row.trackerBinding === null) {
      continue;
    }
    const binding = storedTrackerBinding(row.trackerBinding);
    const one = {
      assignmentId: row.id,
      sourceId: row.sourceId,
      sourceKey: row.sourceKey,
      kind: row.kind,
    };
    if (binding.issueId === undefined) {
      recorded.byKey.set(keyOf(binding.repository, binding.issue), one);
    } else {
      recorded.byIssueId.set(binding.issueId, one);
    }
  }
  return recorded;
}

/** The registered assignment of one issue. A rename keeps the database id, so it matches first. */
function matchRecorded(
  recorded: Recorded,
  issue: { issueId: number; key: string },
): RecordedIssue | null {
  return recorded.byIssueId.get(issue.issueId) ?? recorded.byKey.get(issue.key) ?? null;
}

/**
 * The planning boundary of one item. A wayfinder item takes it from its one type label, and a
 * stated kind may only repeat it. A specification or ticket item takes it from the input.
 */
function kindFor(
  sourceKind: WorkInput["sourceKind"],
  item: ReadItem,
  stated: WorkItem | undefined,
  refusals: Refusal[],
): AssignmentKind | null {
  if (sourceKind !== "wayfinder") {
    return stated?.kind ?? null;
  }

  const label = item.labels.length === 1 ? item.labels[0] : undefined;
  const kind = label === undefined ? null : kindOfWayfinderType(label.slice("wayfinder:".length));
  if (label === undefined || kind === null) {
    refusals.push({ reason: "wayfinder_type_unreadable", key: item.key, labels: item.labels });
    return null;
  }
  if (stated?.kind !== undefined && stated.kind !== kind) {
    refusals.push({ reason: "item_kind_contradicted", key: item.key, stated: stated.kind, label });
  }
  return kind;
}

/** What the input states that the checkout must hold, and what the checkout holds. */
function fixedInputRefusals(item: ReadItem, stated: WorkItem, found: FoundIdentities): Refusal[] {
  return stated.fixedInputs.flatMap((one): Refusal[] => {
    if (one.kind !== "path") {
      return [];
    }
    const foundIdentity = found.get(one.value) ?? null;
    return one.contentIdentity === foundIdentity
      ? []
      : [
          {
            reason: "fixed_input_mismatch",
            key: item.key,
            name: one.name,
            path: one.value,
            statedIdentity: one.contentIdentity,
            foundIdentity,
          },
        ];
  });
}

function bySourceAndKey(
  one: { sourceId: string; key: string },
  other: { sourceId: string; key: string },
) {
  return one.sourceId.localeCompare(other.sourceId) || one.key.localeCompare(other.key);
}

type PlanContext = {
  input: WorkInput;
  found: FoundIdentities;
  recorded: Recorded;
  sourceKey: string;
  repository: string;
  openKeys: Set<string>;
  stated: Map<string, WorkItem>;
  gaps: ReadGap[];
};

/** The refusals of one blocker set, and the dependencies and satisfied blockers it gives. */
function planBlockers(context: PlanContext, item: ReadItem, kind: AssignmentKind | null) {
  const refusals: Refusal[] = [];
  const satisfied: SatisfiedBlocker[] = [];
  const dependsOn: PlannedItem["dependsOn"] = [];
  for (const blocker of item.blockers) {
    if (blocker.state === "closed") {
      satisfied.push({ key: item.key, blocker: blocker.key });
      continue;
    }
    if (context.openKeys.has(blocker.key)) {
      dependsOn.push({ sourceId: context.sourceKey, key: blocker.key });
      continue;
    }
    const registered = matchRecorded(context.recorded, blocker);
    if (registered === null) {
      refusals.push({ reason: "blocker_unregistered", key: item.key, blocker: blocker.key });
    } else if (kind === "production" && registered.kind === "production") {
      // That commit lands only on the integration branch of its own source, so the base of
      // this source could never hold it.
      refusals.push({
        reason: "blocker_in_other_source",
        key: item.key,
        blocker: blocker.key,
        sourceId: registered.sourceId,
        assignmentId: registered.assignmentId,
      });
    } else {
      dependsOn.push({ sourceId: registered.sourceId, key: registered.sourceKey });
    }
  }
  return { refusals, satisfied, dependsOn: dependsOn.toSorted(bySourceAndKey) };
}

/** Plans one open item: its refusals first, then those of its blockers by key. */
function planItem(
  context: PlanContext,
  item: ReadItem,
): { refusals: Refusal[]; satisfied: SatisfiedBlocker[]; item: PlannedItem | null } {
  const own = context.stated.get(item.key);
  const refusals: Refusal[] = [];
  if (own === undefined) {
    refusals.push({ reason: "input_issue_missing", key: item.key });
  }
  const holder = matchRecorded(context.recorded, item);
  if (holder !== null) {
    refusals.push({ reason: "issue_already_registered", key: item.key, sourceId: holder.sourceId });
  }
  const kind = kindFor(context.input.sourceKind, item, own, refusals);
  // A commit lands only on the integration branch of its own source's repository.
  const repository = item.repository.toLowerCase();
  if (kind !== null && isExecutable(kind) && repository !== context.repository) {
    refusals.push({ reason: "executable_item_in_other_repository", key: item.key, repository });
  }
  if (kind === "production" && own !== undefined && own.permissions.writePaths.length === 0) {
    refusals.push({ reason: "write_paths_required", key: item.key });
  }
  if (own !== undefined) {
    refusals.push(...fixedInputRefusals(item, own, context.found));
  }
  for (const gap of context.gaps.filter((one) => one.list === "blockers" && one.key === item.key)) {
    refusals.push({ reason: "tracker_read_incomplete", ...gap });
  }

  const blockers = planBlockers(context, item, kind);
  return {
    refusals: [...refusals, ...blockers.refusals],
    satisfied: blockers.satisfied,
    item:
      kind === null
        ? null
        : {
            key: item.key,
            issueId: item.issueId,
            position: item.position,
            title: item.title,
            kind,
            planningType:
              context.input.sourceKind === "wayfinder" && item.labels.length === 1
                ? planningTypeOf(item.labels[0]?.slice("wayfinder:".length) ?? null)
                : null,
            executable: isExecutable(kind),
            change: "new",
            dependsOn: blockers.dependsOn,
          },
  };
}

/**
 * The registration plan of one read and one input. It changes nothing, so a preview and a
 * registration compute the same plan from the same read, the same input, and the same state.
 */
export function planRegistration(
  db: CrewReader,
  request: { input: WorkInput; read: SourceRead; found: FoundIdentities },
): RegistrationPlan {
  const { input, read, found } = request;
  const repository = input.source.split("#")[0] ?? "";
  const refusals: Refusal[] = [];
  const plan: RegistrationPlan = {
    source: {
      id: input.source,
      kind: input.sourceKind,
      revision: read.status === "read" ? textIdentity(read.parent) : null,
      repository,
    },
    planRevision: identityOf({ read: canonicalRead(read), input } satisfies PlanBasis),
    items: [],
    skipped: [],
    satisfiedBlockers: [],
    refusals,
  };

  if (read.status === "source-missing") {
    refusals.push({ reason: "source_not_found", key: read.key });
    return plan;
  }
  if (read.status === "source-unreadable") {
    refusals.push({ reason: "tracker_read_incomplete", ...read.gap });
    return plan;
  }

  const recorded = recordedIssues(db);
  // GitHub answers a renamed repository under its new name, so the read names the source.
  const sourceKey = read.parent.key;
  plan.source.id = sourceKey;
  plan.source.repository = read.parent.repository.toLowerCase();
  if (recorded.sourceIds.has(sourceKey)) {
    refusals.push({ reason: "source_already_registered", key: sourceKey });
  }
  const withoutParent = recorded.sourcesWithoutParent.get(sourceKey);
  if (withoutParent !== undefined) {
    refusals.push({
      reason: "source_recorded_without_parent",
      key: sourceKey,
      sourceId: withoutParent,
    });
  }
  for (const gap of read.gaps.filter((one) => one.list === "sub-issues")) {
    refusals.push({ reason: "tracker_read_incomplete", ...gap });
  }

  const open = read.items.filter((one) => one.state === "open");
  if (open.length === 0 && read.gaps.length === 0) {
    refusals.push({ reason: "source_without_items", key: sourceKey });
  }

  const openKeys = new Set(open.map((one) => one.key));
  const context: PlanContext = {
    input,
    found,
    recorded,
    sourceKey,
    repository: plan.source.repository,
    openKeys,
    stated: new Map(input.items.map((one) => [one.issue, one])),
    gaps: read.gaps,
  };
  const edges = new Map<string, string[]>();

  for (const item of read.items) {
    if (item.state === "closed") {
      plan.skipped.push({ key: item.key, position: item.position });
      continue;
    }

    const planned = planItem(context, item);
    refusals.push(...planned.refusals);
    plan.satisfiedBlockers.push(...planned.satisfied);
    if (planned.item !== null) {
      plan.items.push(planned.item);
      for (const one of planned.item.dependsOn.filter(
        (dependency) => dependency.sourceId === sourceKey,
      )) {
        edges.set(item.key, [...(edges.get(item.key) ?? []), one.key]);
      }
    }
  }

  for (const one of input.items.toSorted((a, b) => a.issue.localeCompare(b.issue))) {
    if (!openKeys.has(one.issue)) {
      refusals.push({ reason: "input_issue_outside_source", key: one.issue });
    }
  }

  const cycle = findCycle(edges);
  if (cycle !== null) {
    refusals.push({ reason: "dependency_cycle", key: cycle[0] ?? sourceKey, cycle });
  }

  return plan;
}

/**
 * Records exactly the plan that was previewed. The plan is computed again inside the state
 * transaction, so a registration that another source changed since the preview is refused by
 * the same rules the preview used.
 */
export function registerWork(
  db: CrewWriter,
  request: {
    input: WorkInput;
    read: SourceRead;
    found: FoundIdentities;
    planRevision: string;
    differences: PlanDifference[] | null;
    now: string;
  },
): RegisterResult {
  const { input, read, found, now } = request;
  const plan = planRegistration(db, { input, read, found });
  if (plan.planRevision !== request.planRevision) {
    return {
      status: "plan-revision-changed",
      requested: request.planRevision,
      found: plan.planRevision,
      differences: request.differences,
    };
  }
  if (plan.refusals.length > 0 || read.status !== "read" || plan.source.revision === null) {
    return { status: "refused", plan };
  }

  const parent = read.parent;
  const revision = plan.source.revision;
  const orderIndex = db.select().from(workSources).all().length;
  db.insert(workSources)
    .values({
      id: plan.source.id,
      kind: input.sourceKind,
      revision,
      tracker: "github",
      trackerLocation: JSON.stringify({
        repository: parent.repository,
        mapIssue: input.sourceKind === "wayfinder" ? parent.number : null,
        parent: { issue: parent.number, issueId: parent.issueId },
      }),
      orderIndex,
      registeredAt: now,
    })
    .run();

  const readByKey = new Map(read.items.map((one) => [one.key, one]));
  const statedByKey = new Map(input.items.map((one) => [one.issue, one]));
  const registered: RegisteredAssignment[] = [];
  for (const item of plan.items) {
    const issue = readByKey.get(item.key);
    const stated = statedByKey.get(item.key);
    if (issue === undefined || stated === undefined) {
      throw new Error(`the plan names ${item.key}, which its own read or input does not hold`);
    }
    const row = insertAssignment(
      db,
      {
        sourceId: plan.source.id,
        sourceKey: item.key,
        sourceRevision: revision,
        trackerBinding: JSON.stringify({
          repository: issue.repository,
          issue: issue.number,
          issueId: issue.issueId,
        }),
        title: issue.title,
        kind: item.kind,
        planningType: item.planningType,
        orderIndex: item.position,
        approvedScope: issue.body,
        scopeIdentity: textIdentity(issue),
        acceptanceRequirements: stated.acceptanceRequirements,
        permissions: stated.permissions,
        fixedInputs: stated.fixedInputs,
      },
      now,
    );
    registered.push(reported(row));
  }

  for (const item of plan.items) {
    for (const dependency of item.dependsOn) {
      db.insert(assignmentDependencies)
        .values({
          assignmentId: assignmentId(plan.source.id, item.key),
          dependsOnId: assignmentId(dependency.sourceId, dependency.key),
        })
        .onConflictDoNothing()
        .run();
    }
  }

  return {
    status: "registered",
    source: { id: plan.source.id, kind: input.sourceKind, revision, orderIndex },
    planRevision: plan.planRevision,
    registered,
    overlaps: summarize(plan.source.id, findOverlaps(db, plan.source.id), registered),
  };
}

/** Each overlapping pair of one registered source, or a refusal when the source is unknown. */
export function showOverlaps(db: CrewReader, sourceId: string) {
  return db.select().from(workSources).where(eq(workSources.id, sourceId)).all().length === 0
    ? { status: "unknown-source" as const, sourceId }
    : { status: "reported" as const, sourceId, overlaps: findOverlaps(db, sourceId) };
}
