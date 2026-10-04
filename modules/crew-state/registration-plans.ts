import { identityOf } from "./identity.ts";
import type { PlanBasis, PlanDifference, RegistrationPlan } from "./registration.ts";
import type { CanonicalRead } from "./source-read.ts";

/**
 * The full registration plans this checkout previewed, by revision. They stay with the crew
 * state and never enter a worktree. The command that wrote one reports only a summary and this
 * path, so its reader opens the detail only when it needs it.
 */
const PLAN_STORE = ".operator/local/registration-plans";

export function planPathOf(planRevision: string): string {
  return `${PLAN_STORE}/${planRevision}.json`;
}

type StoredPlan = RegistrationPlan & { basis: PlanBasis };

/** Writes the full plan under its revision. The same plan always writes the same bytes. */
export async function storePlan(
  projectRoot: string,
  plan: RegistrationPlan,
  basis: PlanBasis,
): Promise<string> {
  const path = planPathOf(plan.planRevision);
  const stored: StoredPlan = { ...plan, basis };
  await Bun.write(`${projectRoot}/${path}`, `${JSON.stringify(stored, null, 2)}\n`, {
    createPath: true,
  });
  return path;
}

async function storedBasis(projectRoot: string, planRevision: string): Promise<PlanBasis | null> {
  // A revision is a content identity, so any other spelling names no stored plan.
  if (!/^[0-9a-f]{64}$/.test(planRevision)) {
    return null;
  }
  const file = Bun.file(`${projectRoot}/${planPathOf(planRevision)}`);
  if (!(await file.exists())) {
    return null;
  }
  const stored: { basis?: PlanBasis } = await file.json().catch(() => ({}));
  return stored.basis ?? null;
}

function byKey<Entry extends { key: string }>(entries: Entry[] | undefined): Map<string, string> {
  return new Map((entries ?? []).map((one) => [one.key, identityOf(one)]));
}

function compared(
  part: PlanDifference["part"],
  before: Map<string, string>,
  after: Map<string, string>,
): PlanDifference[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  return keys.flatMap((key): PlanDifference[] => {
    const was = before.get(key);
    const is = after.get(key);
    if (was === is) {
      return [];
    }
    return [
      { part, key, change: was === undefined ? "added" : is === undefined ? "removed" : "changed" },
    ];
  });
}

/**
 * What differs between the plan a revision named and the plan a new read gives: the source,
 * each item, and each input entry, in that order and then by key. It is null when this checkout
 * holds no preview under that revision, so nothing can be compared.
 */
export async function planDifferences(
  projectRoot: string,
  requested: string,
  current: PlanBasis,
): Promise<PlanDifference[] | null> {
  const before = await storedBasis(projectRoot, requested);
  if (before === null) {
    return null;
  }

  const read = (one: CanonicalRead) => ({
    status: one.status,
    key: one.key,
    gap: one.gap,
    parent: one.parent,
    gaps: one.gaps,
  });
  const source: PlanDifference[] =
    identityOf(read(before.read)) === identityOf(read(current.read))
      ? []
      : [{ part: "source", key: current.input.source, change: "changed" }];
  const inputHead = (one: PlanBasis["input"]) => ({
    sourceKind: one.sourceKind,
    source: one.source,
  });
  const input: PlanDifference[] =
    identityOf(inputHead(before.input)) === identityOf(inputHead(current.input))
      ? []
      : [{ part: "input", key: current.input.source, change: "changed" }];

  return [
    ...source,
    ...compared("item", byKey(before.read.items), byKey(current.read.items)),
    ...input,
    ...compared(
      "input",
      byKey(before.input.items.map((one) => ({ ...one, key: one.issue }))),
      byKey(current.input.items.map((one) => ({ ...one, key: one.issue }))),
    ),
  ];
}
