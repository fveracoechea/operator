// Bun has no real-path API.
import { realpath } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { CrewReader, CrewWriter } from "./database.ts";
import { type AssignmentRow, insertAssignment, readAssignment } from "./assignment.ts";
import { matchApproval } from "./approvals.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import { assignmentId, identityOf } from "./identity.ts";
import { integrationBranchOf } from "./integration.ts";
import {
  assignmentDependencies,
  assignments,
  attempts,
  trackerOperations,
  workSources,
} from "./schema.ts";
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
  storedFixedInputs,
  storedPermissions,
  storedRequirements,
  storedTrackerBinding,
  storedTrackerLocation,
  type WorkInput,
  type WorkItem,
} from "./work-input.ts";
import { writePathsReader } from "./write-path-grants.ts";
import { overlappingPaths, overlapsCommand } from "./write-paths.ts";
import { recordedLanding } from "./submission.ts";
import { type WithdrawalRefusal, withdrawAssignment, withdrawalRefusals } from "./withdrawal.ts";
import { laterCommitsOf, pendingTakeOutsOf } from "./take-out.ts";
import { currentLandingOf } from "./landing-record.ts";
import { registerBranchReview, type RegisteredBranchReview } from "./branch-review.ts";

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
  // A new read keeps a recorded item that did not change, and updates one that no work read.
  change: "new" | "updated" | "unchanged";
  dependsOn: Array<{ sourceId: string; key: string }>;
};

/**
 * One recorded item that the read no longer finds, because a person removed its issue from the
 * parent. The plan records it as withdrawn behind the approval of this plan revision.
 */
export type PlannedWithdrawal = {
  key: string;
  assignmentId: string;
  state: string;
  // The commit that carries its accepted code result, or null when none landed.
  landing: string | null;
  // The landed commits above that commit, oldest first, which the take-out rebuilds. They are
  // read from the crew state with no Git read (ADR 0020).
  rebuilds: string[];
};

/**
 * The action of the approval a new read needs before it records a new source revision, a changed
 * item, or a withdrawal. It binds the registration plan revision, so it covers exactly what was
 * previewed.
 */
export const REGISTRATION_CHANGE_APPROVAL = "registration-change";

/** The exact approval one plan needs, in the shape a person grants it. */
export type RegistrationApproval = {
  action: string;
  targets: string[];
  scope: string;
  requestRevision: string;
};

const CLOSED_ITEM_HINT = "remove it from its parent to withdraw it, or reopen it";

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
  | { reason: "source_kind_changed"; key: string; recorded: string; stated: string }
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
  | { reason: "recorded_item_changed"; key: string; assignmentId: string; state: string }
  | {
      reason: "recorded_item_closed";
      key: string;
      assignmentId: string;
      state: string;
      hint: string;
    }
  | { reason: "withdrawn_item_readded"; key: string; assignmentId: string }
  | { reason: "blocker_withdrawn"; key: string; blocker: string; assignmentId: string }
  | WithdrawalRefusal
  | {
      // A withdrawal of landed work while an earlier take-out of the source still waits. Each
      // take-out is bound to one plan revision, so the person withdraws it after that one (D5).
      reason: "take_out_pending";
      key: string;
      assignmentId: string;
      pending: string[];
    }
  | {
      reason: "withdrawal_dependent_pending";
      key: string;
      assignmentId: string;
      dependent: string;
      dependentKey: string;
    }
  | {
      reason: "blocker_completed_after_base";
      key: string;
      blocker: string;
      sourceId: string;
      assignmentId: string;
      completedAt: string;
      baseFixedAt: string;
    }
  | { reason: "dependency_cycle"; key: string; cycle: string[] };

export type RegistrationPlan = {
  source: {
    id: string;
    kind: string;
    revision: string | null;
    repository: string;
    // A new read of a registered source changes its revision only behind the approval.
    change: "new" | "changed" | "unchanged";
  };
  planRevision: string;
  approval: RegistrationApproval | null;
  items: PlannedItem[];
  withdrawals: PlannedWithdrawal[];
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
      updated: RegisteredAssignment[];
      withdrawn: RegisteredAssignment[];
      overlaps: OverlapSummary;
      // The branch review a withdrawal registered, because it made the branch final.
      branchReview: RegisteredBranchReview | null;
    }
  | { status: "refused"; plan: RegistrationPlan }
  | { status: "approval-required"; approval: RegistrationApproval }
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

/**
 * Finds one dependency cycle, so a registration that would deadlock dispatch is refused. It
 * walks the nodes and their edges in the order of their labels, so the same graph always names
 * the same cycle.
 */
function findCycle(
  graph: Map<string, string[]>,
  labelOf: (node: string) => string,
): string[] | null {
  const byLabel = (one: string, other: string) => labelOf(one).localeCompare(labelOf(other));
  const edges = new Map([...graph].map(([node, next]) => [node, next.toSorted(byLabel)]));
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

  for (const node of [...edges.keys()].toSorted(byLabel)) {
    const cycle = walk(node);
    if (cycle !== null) {
      return cycle.map(labelOf);
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
    // Withdrawn work never runs again, so it orders nothing and overlaps nothing.
    .filter((row) => row.kind === "production" && row.state !== "withdrawn")
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

/** One registered source that a new read of its parent issue can match. */
type RecordedSource = {
  id: string;
  kind: string;
  revision: string;
  orderIndex: number;
  repository: string;
  parentIssueId: number | null;
};

type Recorded = {
  sources: RecordedSource[];
  // A source an earlier release registered has no parent issue, so its map issue names it.
  sourcesWithoutParent: Map<string, string>;
  byIssueId: Map<number, RecordedIssue>;
  // A binding an earlier release recorded holds no database id, so only its key can match.
  byKey: Map<string, RecordedIssue>;
  // The key of every assignment, so a cycle is named by its items.
  keyById: Map<string, string>;
  edges: Map<string, string[]>;
  // The assignments that wait on each one, in any source.
  dependents: Map<string, string[]>;
  // Every assignment a person withdrew earlier.
  withdrawn: Set<string>;
  attempted: Set<string>;
};

function recordedIssues(db: CrewReader): Recorded {
  const recorded: Recorded = {
    sources: [],
    sourcesWithoutParent: new Map(),
    byIssueId: new Map(),
    byKey: new Map(),
    keyById: new Map(),
    edges: dependencyEdges(db),
    dependents: new Map(),
    withdrawn: new Set(),
    attempted: new Set(
      db
        .select()
        .from(attempts)
        .all()
        .map((one) => one.assignmentId),
    ),
  };
  for (const source of db.select().from(workSources).orderBy(workSources.orderIndex).all()) {
    const location =
      source.trackerLocation === null ? null : storedTrackerLocation(source.trackerLocation);
    recorded.sources.push({
      id: source.id,
      kind: source.kind,
      revision: source.revision,
      orderIndex: source.orderIndex,
      repository: location?.repository.toLowerCase() ?? "",
      parentIssueId: location?.parent?.issueId ?? null,
    });
    if (location !== null && location.parent === undefined && location.mapIssue !== null) {
      recorded.sourcesWithoutParent.set(keyOf(location.repository, location.mapIssue), source.id);
    }
  }
  for (const [waiting, blockers] of recorded.edges) {
    for (const blocker of blockers) {
      recorded.dependents.set(blocker, [...(recorded.dependents.get(blocker) ?? []), waiting]);
    }
  }
  for (const row of db.select().from(assignments).orderBy(assignments.orderIndex).all()) {
    recorded.keyById.set(row.id, row.sourceKey);
    if (row.state === "withdrawn") {
      recorded.withdrawn.add(row.id);
    }
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
  // The repository the source was registered in. A rename moves it with every item.
  recordedRepository: string;
  openKeys: Set<string>;
  stated: Map<string, WorkItem>;
  gaps: ReadGap[];
  // The recorded items of this source by issue database id, and their keys by the read key.
  held: Map<number, AssignmentRow>;
  heldKeys: Map<string, string>;
  // Every assignment that is withdrawn, earlier or by this plan.
  withdrawn: Set<string>;
  // When the integration base of this source was fixed, and when each recorded assignment
  // completed, both from the crew state only. A source with no base fixes nothing yet.
  baseFixedAt: string | null;
  completedAt: Map<string, string>;
};

/**
 * A production blocker in another source that completed after the integration base of this
 * source was fixed. Its commit reached the target after that base, so the branch of this source
 * can never hold it, whatever the tracker shows now (ADR 0016). The check reads only crew state.
 */
function completedAfterBase(
  context: PlanContext,
  item: ReadItem,
  kind: AssignmentKind | null,
  blocker: ReadItem["blockers"][number],
): Refusal | null {
  // Only a new item is checked. A recorded item keeps the links it was registered with.
  if (context.baseFixedAt === null || kind !== "production" || context.held.has(item.issueId)) {
    return null;
  }
  const registered = matchRecorded(context.recorded, blocker);
  if (
    registered === null ||
    registered.kind !== "production" ||
    registered.sourceId === context.sourceKey
  ) {
    return null;
  }
  const completedAt = context.completedAt.get(registered.assignmentId);
  return completedAt === undefined || completedAt <= context.baseFixedAt
    ? null
    : {
        reason: "blocker_completed_after_base",
        key: item.key,
        blocker: blocker.key,
        sourceId: registered.sourceId,
        assignmentId: registered.assignmentId,
        completedAt,
        baseFixedAt: context.baseFixedAt,
      };
}

/** When the integration base of one source was fixed, or null before its first code dispatch. */
function baseFixedAtOf(db: CrewReader, sourceId: string): string | null {
  return integrationBranchOf(db, sourceId)?.fixedAt ?? null;
}

/** When each recorded assignment completed: its tracker completion step succeeded. */
function completionTimes(db: CrewReader): Map<string, string> {
  return new Map(
    db
      .select({ assignmentId: trackerOperations.assignmentId, at: trackerOperations.updatedAt })
      .from(trackerOperations)
      .where(
        and(eq(trackerOperations.step, "completion"), eq(trackerOperations.state, "succeeded")),
      )
      .all()
      .map((one) => [one.assignmentId, one.at]),
  );
}

/**
 * The refusals of one blocker set, and the dependencies and satisfied blockers it gives. A
 * closed blocker gates nothing, but it keeps a dependency that its item already recorded,
 * because accepted work that closes is not a change of the blocking links.
 */
function planBlockers(
  context: PlanContext,
  item: ReadItem,
  kind: AssignmentKind | null,
  kept: Set<string>,
) {
  const refusals: Refusal[] = [];
  const satisfied: SatisfiedBlocker[] = [];
  const dependsOn: PlannedItem["dependsOn"] = [];
  for (const blocker of item.blockers) {
    const late = completedAfterBase(context, item, kind, blocker);
    if (late !== null) {
      refusals.push(late);
      continue;
    }
    const registered = matchRecorded(context.recorded, blocker);
    // A withdrawn item never satisfies a dependency. A link the dependent recorded stays, so the
    // withdrawal names that dependent, and a new link to it would wait for ever.
    if (registered !== null && context.withdrawn.has(registered.assignmentId)) {
      if (kept.has(registered.assignmentId)) {
        dependsOn.push({ sourceId: registered.sourceId, key: registered.sourceKey });
      } else {
        refusals.push({
          reason: "blocker_withdrawn",
          key: item.key,
          blocker: blocker.key,
          assignmentId: registered.assignmentId,
        });
      }
      continue;
    }
    if (blocker.state === "closed") {
      if (registered !== null && kept.has(registered.assignmentId)) {
        dependsOn.push({ sourceId: registered.sourceId, key: registered.sourceKey });
      } else {
        satisfied.push({ key: item.key, blocker: blocker.key });
      }
      continue;
    }
    if (context.openKeys.has(blocker.key)) {
      dependsOn.push({
        sourceId: context.sourceKey,
        key: context.heldKeys.get(blocker.key) ?? blocker.key,
      });
      continue;
    }
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

/** Where an item lives against its source: the same repository, or the one it names. */
function placeOf(repository: string, sourceRepository: string): string {
  const own = repository.toLowerCase();
  return own === sourceRepository ? "" : own;
}

/** The execution fields of one item. A wayfinder item takes its kind from the tracker. */
function executionOf(
  fields: Pick<WorkItem, "acceptanceRequirements" | "permissions" | "fixedInputs"> & {
    kind?: string;
  },
  wayfinder: boolean,
) {
  return identityOf({
    acceptanceRequirements: fields.acceptanceRequirements,
    permissions: fields.permissions,
    fixedInputs: fields.fixedInputs,
    kind: wayfinder ? null : (fields.kind ?? null),
  });
}

/**
 * Whether a recorded item differs from what a new read gives: its text, its kind, its place,
 * its blocking links, or the execution fields the input states for it.
 */
function changed(
  context: PlanContext,
  read: { item: ReadItem; own: WorkItem | undefined; kind: AssignmentKind | null },
  row: AssignmentRow,
  planned: { planningType: string | null; blockers: ReturnType<typeof planBlockers> },
): boolean {
  const { item, own, kind } = read;
  const wayfinder = context.input.sourceKind === "wayfinder";
  const binding = row.trackerBinding === null ? null : storedTrackerBinding(row.trackerBinding);
  const dependsOn = planned.blockers.dependsOn
    .map((one) => assignmentId(one.sourceId, one.key))
    .toSorted();
  const tracker =
    textIdentity(item) !== row.scopeIdentity ||
    kind !== row.kind ||
    planned.planningType !== row.planningType ||
    placeOf(item.repository, context.repository) !==
      placeOf(binding?.repository ?? "", context.recordedRepository) ||
    planned.blockers.refusals.length > 0 ||
    identityOf(dependsOn) !== identityOf((context.recorded.edges.get(row.id) ?? []).toSorted());
  const recorded = {
    acceptanceRequirements: storedRequirements(row.acceptanceRequirements),
    permissions: storedPermissions(row.permissions),
    fixedInputs: storedFixedInputs(row.fixedInputs),
    kind: row.kind,
  };
  return (
    tracker ||
    (own !== undefined && executionOf(own, wayfinder) !== executionOf(recorded, wayfinder))
  );
}

/** The kind a recorded specification or ticket item keeps when the input does not restate it. */
function recordedKind(row: AssignmentRow): AssignmentKind {
  return row.kind === "planning" ? "planning" : "production";
}

/** What refuses one item that this registration would write, new or updated, in a fixed order. */
function recordRefusals(
  context: PlanContext,
  read: {
    item: ReadItem;
    own: WorkItem | undefined;
    kind: AssignmentKind | null;
    recorded: boolean;
    kindRefusals: Refusal[];
  },
): Refusal[] {
  const { item, own, kind } = read;
  const refusals: Refusal[] = [];
  if (own === undefined) {
    refusals.push({ reason: "input_issue_missing", key: item.key });
  }
  const holder = read.recorded ? null : matchRecorded(context.recorded, item);
  if (holder !== null) {
    refusals.push({ reason: "issue_already_registered", key: item.key, sourceId: holder.sourceId });
  }
  refusals.push(...read.kindRefusals);
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
  return refusals;
}

/**
 * Plans one open item: its refusals first, then those of its blockers by key. A recorded item
 * that did not change is kept, and one that changed is updated only when no work has read it.
 */
function planItem(
  context: PlanContext,
  item: ReadItem,
): { refusals: Refusal[]; satisfied: SatisfiedBlocker[]; item: PlannedItem | null } {
  const own = context.stated.get(item.key);
  const row = context.held.get(item.issueId) ?? null;
  const kindRefusals: Refusal[] = [];
  const kind =
    row !== null && context.input.sourceKind !== "wayfinder"
      ? (own?.kind ?? recordedKind(row))
      : kindFor(context.input.sourceKind, item, own, kindRefusals);
  const planningType =
    context.input.sourceKind === "wayfinder" && item.labels.length === 1
      ? planningTypeOf(item.labels[0]?.slice("wayfinder:".length) ?? null)
      : null;
  const blockers = planBlockers(
    context,
    item,
    kind,
    new Set(row === null ? [] : (context.recorded.edges.get(row.id) ?? [])),
  );
  const gaps = context.gaps
    .filter((one) => one.list === "blockers" && one.key === item.key)
    .map((gap): Refusal => ({ reason: "tracker_read_incomplete", ...gap }));
  const change =
    row === null
      ? "new"
      : changed(context, { item, own, kind }, row, { planningType, blockers })
        ? "updated"
        : "unchanged";
  const planned = (key: string): PlannedItem | null =>
    kind === null
      ? null
      : {
          key,
          issueId: item.issueId,
          position: item.position,
          title: item.title,
          kind,
          planningType,
          executable: isExecutable(kind),
          change,
          dependsOn: blockers.dependsOn,
        };

  if (row !== null && change === "unchanged") {
    return {
      refusals: [...kindRefusals, ...gaps],
      satisfied: blockers.satisfied,
      item: planned(row.sourceKey),
    };
  }
  // Its writer or its dependents read the recorded text, so the change goes in a new sub-issue.
  if (row !== null && (row.state !== "registered" || context.recorded.attempted.has(row.id))) {
    return {
      refusals: [
        ...kindRefusals,
        { reason: "recorded_item_changed", key: item.key, assignmentId: row.id, state: row.state },
        ...gaps,
      ],
      satisfied: blockers.satisfied,
      item: null,
    };
  }

  return {
    refusals: [
      ...recordRefusals(context, { item, own, kind, recorded: row !== null, kindRefusals }),
      ...gaps,
      ...blockers.refusals,
    ],
    satisfied: blockers.satisfied,
    item: planned(row?.sourceKey ?? item.key),
  };
}

/** A recorded item the read finds closed. Only accepted work may close, because Operator closes it. */
function planClosed(row: AssignmentRow, item: ReadItem): Refusal | PlannedItem {
  if (row.state !== "accepted") {
    return {
      reason: "recorded_item_closed",
      key: item.key,
      assignmentId: row.id,
      state: row.state,
      hint: CLOSED_ITEM_HINT,
    };
  }
  const kind = row.kind === "planning" ? "planning" : "production";
  return {
    key: row.sourceKey,
    issueId: item.issueId,
    position: item.position,
    title: item.title,
    kind,
    planningType: planningTypeOf(row.planningType),
    executable: isExecutable(kind),
    change: "unchanged",
    // A closed item reads no blockers, and accepted work waits on nothing.
    dependsOn: [],
  };
}

/**
 * The registered source a read of its parent issue names. A rename keeps the database id of the
 * parent, so it matches first. A source with the same key and another parent is a refusal.
 */
function matchSource(
  recorded: Recorded,
  parent: { issueId: number; key: string },
): { source: RecordedSource | null; clash: boolean } {
  const source = recorded.sources.find((one) => one.parentIssueId === parent.issueId) ?? null;
  return {
    source,
    clash: source === null && recorded.sources.some((one) => one.id === parent.key),
  };
}

/** The recorded items of one source that a read can find, by issue database id. */
function heldItems(db: CrewReader, sourceId: string | null): Map<number, AssignmentRow> {
  const held = new Map<number, AssignmentRow>();
  if (sourceId === null) {
    return held;
  }
  for (const row of db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, sourceId))
    .orderBy(assignments.orderIndex)
    .all()) {
    const binding = row.trackerBinding === null ? null : storedTrackerBinding(row.trackerBinding);
    if (binding?.issueId !== undefined) {
      held.set(binding.issueId, row);
    }
  }
  return held;
}

/** What refuses the source of one read, before any of its items. */
function sourceRefusals(
  recorded: Recorded,
  request: {
    read: Extract<SourceRead, { status: "read" }>;
    input: WorkInput;
    sourceKey: string;
    existing: RecordedSource | null;
    clash: boolean;
  },
): Refusal[] {
  const { read, input, sourceKey, existing } = request;
  const refusals: Refusal[] = [];
  if (request.clash) {
    refusals.push({ reason: "source_already_registered", key: sourceKey });
  }
  if (existing !== null && existing.kind !== input.sourceKind) {
    refusals.push({
      reason: "source_kind_changed",
      key: sourceKey,
      recorded: existing.kind,
      stated: input.sourceKind,
    });
  }
  const withoutParent = recorded.sourcesWithoutParent.get(read.parent.key);
  if (withoutParent !== undefined) {
    refusals.push({
      reason: "source_recorded_without_parent",
      key: read.parent.key,
      sourceId: withoutParent,
    });
  }
  for (const gap of read.gaps.filter((one) => one.list === "sub-issues")) {
    refusals.push({ reason: "tracker_read_incomplete", ...gap });
  }
  return refusals;
}

/**
 * One dependency cycle the plan would record, named by item keys. Each new or updated item
 * replaces the recorded edges of its assignment, and the whole graph is checked again, so a
 * changed item cannot close a cycle through work already recorded.
 */
function cycleOf(recorded: Recorded, sourceId: string, items: PlannedItem[]): string[] | null {
  const graph = new Map(recorded.edges);
  const keyById = new Map(recorded.keyById);
  for (const item of items.filter((one) => one.change !== "unchanged")) {
    const id = assignmentId(sourceId, item.key);
    keyById.set(id, item.key);
    graph.set(
      id,
      item.dependsOn.map((one) => assignmentId(one.sourceId, one.key)),
    );
  }
  return findCycle(graph, (id) => keyById.get(id) ?? id);
}

/**
 * Each recorded dependent, in any source, that still waits on one withdrawn item. A dependent
 * settles it only by its own withdrawal, or by a new read that drops the link. Dropping it is a
 * changed item, so only a dependent that no work has read can do it.
 */
function dependentRefusals(
  context: PlanContext,
  items: PlannedItem[],
  row: AssignmentRow,
): Refusal[] {
  const planned = new Map(items.map((one) => [assignmentId(context.sourceKey, one.key), one]));
  return (context.recorded.dependents.get(row.id) ?? []).toSorted().flatMap((dependent) => {
    const item = planned.get(dependent);
    const dropped =
      item !== undefined &&
      item.change === "updated" &&
      !item.dependsOn.some((one) => assignmentId(one.sourceId, one.key) === row.id);
    return context.withdrawn.has(dependent) || dropped
      ? []
      : [
          {
            reason: "withdrawal_dependent_pending" as const,
            key: row.sourceKey,
            assignmentId: row.id,
            dependent,
            dependentKey: context.recorded.keyById.get(dependent) ?? dependent,
          },
        ];
  });
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
      change: "new",
    },
    planRevision: identityOf({ read: canonicalRead(read), input } satisfies PlanBasis),
    approval: null,
    items: [],
    withdrawals: [],
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
  const { source: existing, clash } = matchSource(recorded, read.parent);
  // GitHub answers a renamed repository under its new name, so a new source takes the name the
  // read gives, and a registered source keeps the id it was registered under.
  const sourceKey = existing?.id ?? read.parent.key;
  plan.source.id = sourceKey;
  plan.source.repository = read.parent.repository.toLowerCase();
  if (existing !== null) {
    plan.source.change = existing.revision === plan.source.revision ? "unchanged" : "changed";
  }
  refusals.push(...sourceRefusals(recorded, { read, input, sourceKey, existing, clash }));

  const open = read.items.filter((one) => one.state === "open");
  if (open.length === 0 && read.gaps.length === 0) {
    refusals.push({ reason: "source_without_items", key: sourceKey });
  }

  const held = heldItems(db, existing?.id ?? null);
  // A person withdraws an item by removing its issue from the parent, so the read misses it.
  const readIds = new Set(read.items.map((one) => one.issueId));
  const missing = [...held]
    .filter(([issueId, row]) => row.state !== "withdrawn" && !readIds.has(issueId))
    .map(([, row]) => row);
  const context: PlanContext = {
    input,
    found,
    recorded,
    sourceKey,
    repository: plan.source.repository,
    recordedRepository: existing?.repository ?? plan.source.repository,
    openKeys: new Set(open.map((one) => one.key)),
    stated: new Map(input.items.map((one) => [one.issue, one])),
    gaps: read.gaps,
    held,
    heldKeys: new Map(
      read.items.flatMap((one) => {
        const row = held.get(one.issueId);
        return row === undefined ? [] : [[one.key, row.sourceKey]];
      }),
    ),
    withdrawn: new Set([...recorded.withdrawn, ...missing.map((row) => row.id)]),
    baseFixedAt: baseFixedAtOf(db, sourceKey),
    completedAt: completionTimes(db),
  };

  for (const item of read.items) {
    const row = held.get(item.issueId);
    // The issue matches its withdrawn item by its database id, so a new sub-issue carries the work.
    if (row !== undefined && row.state === "withdrawn") {
      refusals.push({ reason: "withdrawn_item_readded", key: item.key, assignmentId: row.id });
      continue;
    }
    if (item.state === "closed") {
      if (row === undefined) {
        plan.skipped.push({ key: item.key, position: item.position });
      } else {
        const closed = planClosed(row, item);
        if ("reason" in closed) {
          refusals.push(closed);
        } else {
          plan.items.push(closed);
        }
      }
      continue;
    }

    const planned = planItem(context, item);
    refusals.push(...planned.refusals);
    plan.satisfiedBlockers.push(...planned.satisfied);
    if (planned.item !== null) {
      plan.items.push(planned.item);
    }
  }

  for (const row of missing) {
    const planned = planWithdrawal(db, row);
    plan.withdrawals.push(planned.withdrawal);
    refusals.push(...planned.refusals);
    refusals.push(...dependentRefusals(context, plan.items, row));
  }

  for (const one of input.items.toSorted((a, b) => a.issue.localeCompare(b.issue))) {
    if (!context.openKeys.has(one.issue)) {
      refusals.push({ reason: "input_issue_outside_source", key: one.issue });
    }
  }

  const cycle = cycleOf(recorded, sourceKey, plan.items);
  if (cycle !== null) {
    refusals.push({ reason: "dependency_cycle", key: cycle[0] ?? sourceKey, cycle });
  }

  if (
    plan.source.change === "changed" ||
    plan.items.some((one) => one.change === "updated") ||
    plan.withdrawals.length > 0
  ) {
    plan.approval = {
      action: REGISTRATION_CHANGE_APPROVAL,
      targets: [sourceKey],
      scope: sourceKey,
      requestRevision: plan.planRevision,
    };
  }

  return plan;
}

/**
 * The withdrawal of one recorded item that the read does not find, with what refuses it. Its
 * recorded landing and the later commits that the take-out rebuilds are read from the crew state
 * with no Git read. A second withdrawal of landed work waits until the earlier take-out of the
 * source ran, because each take-out is bound to the one plan revision that recorded it (D5).
 */
function planWithdrawal(
  db: CrewReader,
  row: AssignmentRow,
): { withdrawal: PlannedWithdrawal; refusals: Refusal[] } {
  const waiting = pendingTakeOutsOf(db, row.sourceId);
  const landed = currentLandingOf(db, row.id);
  const refusals: Refusal[] =
    landed !== null && waiting.length > 0
      ? [
          {
            reason: "take_out_pending",
            key: row.sourceKey,
            assignmentId: row.id,
            pending: waiting.map((one) => one.assignmentId),
          },
        ]
      : [];
  return {
    withdrawal: {
      key: row.sourceKey,
      assignmentId: row.id,
      state: row.state,
      landing: recordedLanding(db, row.id),
      rebuilds:
        landed === null
          ? []
          : laterCommitsOf(db, { sourceId: row.sourceId, commit: landed.landedCommit }),
    },
    refusals: [...refusals, ...withdrawalRefusals(db, row)],
  };
}

/** Writes the new content of one recorded item that no work has read. */
function updateAssignment(
  db: CrewWriter,
  request: {
    row: AssignmentRow;
    issue: ReadItem;
    item: PlannedItem;
    stated: WorkItem;
    sourceRevision: string;
    now: string;
  },
): AssignmentRow {
  const { row, issue, item, stated } = request;
  const values = {
    sourceRevision: request.sourceRevision,
    trackerBinding: JSON.stringify({
      repository: issue.repository,
      issue: issue.number,
      issueId: issue.issueId,
    }),
    title: issue.title,
    kind: item.kind,
    planningType: item.planningType,
    approvedScope: issue.body,
    scopeIdentity: textIdentity(issue),
    acceptanceRequirements: JSON.stringify(stated.acceptanceRequirements),
    permissions: JSON.stringify(stated.permissions),
    fixedInputs: JSON.stringify(stated.fixedInputs),
    fixedInputsIdentity: identityOf(stated.fixedInputs),
    revision: row.revision + 1,
    updatedAt: request.now,
  };
  db.update(assignments).set(values).where(eq(assignments.id, row.id)).run();
  db.delete(assignmentDependencies).where(eq(assignmentDependencies.assignmentId, row.id)).run();
  return { ...row, ...values };
}

/**
 * Records exactly the plan that was previewed. The plan is computed again inside the state
 * transaction, so a registration that another source changed since the preview is refused by
 * the same rules the preview used. A new source revision and a changed item are recorded only
 * under the person's approval of this plan revision.
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
  if (plan.approval !== null && matchApproval(db, plan.approval).status !== "matched") {
    return { status: "approval-required", approval: plan.approval };
  }

  const parent = read.parent;
  const revision = plan.source.revision;
  const existing = matchSource(recordedIssues(db), parent).source;
  const orderIndex = existing?.orderIndex ?? db.select().from(workSources).all().length;
  if (existing === null) {
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
  } else if (plan.source.change === "changed") {
    db.update(workSources).set({ revision }).where(eq(workSources.id, existing.id)).run();
  }

  const held = heldItems(db, plan.source.id);
  const readById = new Map(read.items.map((one) => [one.issueId, one]));
  const statedByKey = new Map(input.items.map((one) => [one.issue, one]));
  const registered: RegisteredAssignment[] = [];
  const updated: RegisteredAssignment[] = [];
  for (const item of plan.items) {
    const issue = readById.get(item.issueId);
    const stated = issue === undefined ? undefined : statedByKey.get(issue.key);
    const row = held.get(item.issueId);
    if (issue === undefined) {
      throw new Error(`the plan names ${item.key}, which its own read does not hold`);
    }
    // The stored sub-issue position only breaks ties, so a new position needs no approval.
    if (row !== undefined && row.orderIndex !== item.position) {
      db.update(assignments)
        .set({ orderIndex: item.position })
        .where(eq(assignments.id, row.id))
        .run();
    }
    if (item.change === "unchanged") {
      continue;
    }
    if (stated === undefined) {
      throw new Error(`the plan names ${item.key}, which its own input does not hold`);
    }
    if (row !== undefined) {
      updated.push(
        reported(
          updateAssignment(db, {
            row: { ...row, orderIndex: item.position },
            issue,
            item,
            stated,
            sourceRevision: revision,
            now,
          }),
        ),
      );
      continue;
    }
    const inserted = insertAssignment(
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
    registered.push(reported(inserted));
  }

  // Operator writes nothing to the tracker here: the removal the person made is the record.
  const withdrawn: RegisteredAssignment[] = [];
  for (const one of plan.withdrawals) {
    const row = readAssignment(db, one.assignmentId);
    if (row === null) {
      throw new Error(`the plan withdraws ${one.key}, which the crew state does not hold`);
    }
    withdrawAssignment(db, { row, planRevision: plan.planRevision, now });
    withdrawn.push(reported({ ...row, state: "withdrawn", revision: row.revision + 1 }));
  }

  for (const item of plan.items.filter((one) => one.change !== "unchanged")) {
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

  // The withdrawal that makes the integration branch final registers its branch review in the
  // same change (ADR 0017). A withdrawn commit that the branch still holds waits for its take-out.
  const branchReview =
    plan.withdrawals.length === 0
      ? null
      : registerBranchReview(db, { sourceId: plan.source.id, now });

  const all = db
    .select()
    .from(assignments)
    .where(eq(assignments.sourceId, plan.source.id))
    .all()
    .map(reported);
  return {
    status: "registered",
    source: { id: plan.source.id, kind: input.sourceKind, revision, orderIndex },
    planRevision: plan.planRevision,
    registered,
    updated,
    withdrawn,
    overlaps: summarize(plan.source.id, findOverlaps(db, plan.source.id), all),
    branchReview,
  };
}

/** Each overlapping pair of one registered source, or a refusal when the source is unknown. */
export function showOverlaps(db: CrewReader, sourceId: string) {
  return db.select().from(workSources).where(eq(workSources.id, sourceId)).all().length === 0
    ? { status: "unknown-source" as const, sourceId }
    : { status: "reported" as const, sourceId, overlaps: findOverlaps(db, sourceId) };
}
