import { Err, Ok, fromThrowable, type AsyncOkOf, type AsyncResult, type Result } from "unthrown";
import { z } from "zod";
import { WorkSources } from "../work-sources/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { PrStacks } from "../pr-stacks/main.ts";
import type { Owner, Paths } from "./owner.ts";
import type { Refusal } from "../../lib/cli-result.ts";

type Source = NonNullable<AsyncOkOf<ReturnType<typeof WorkSources.show>>>;
type StackParent = ReturnType<typeof PrStacks.decode>["parents"][number];
type Spec = Pick<StackParent, "assignment" | "number" | "branch">;
type Binding = { assignment: string; parents: StackParent[] };

function refuse(detail: string): Result<never, Refusal> {
  return Err({
    reason: "stack_parent",
    detail,
    next: {
      command: "operator pr stack plan",
      why: "Choose implemented, acyclic prerequisites from this source.",
    },
  });
}

function cyclic(source: Source, child: string, parents: string[], bindings: Binding[]) {
  const graph = new Map(source.planned.map((row) => [row.key, row.dependencies]));
  for (const binding of bindings)
    graph.set(binding.assignment, [
      ...(graph.get(binding.assignment) ?? []),
      ...binding.parents.map((row) => row.assignment),
    ]);
  const seen = new Set<string>();
  const pending = [...parents];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined) continue;
    if (key === child) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(...(graph.get(key) ?? []));
  }
  return false;
}

function selected(
  source: Source,
  keys: string[],
  additional: Set<string>,
): Result<Spec[], Refusal> {
  const assignments = new Map(source.assignments.map((row) => [row.key, row]));
  const pulls = new Map(source.pullRequests.map((row) => [row.assignment, row]));
  const parents: Spec[] = [];
  for (const key of keys.toSorted()) {
    const dependency = assignments.get(key);
    if (dependency === undefined)
      return refuse(`Prerequisite ${key} does not belong to this source.`);
    if (dependency.completion === "report") {
      if (additional.has(key) || dependency.state !== "completed")
        return refuse(`Report ${key} is not an accepted code prerequisite.`);
      continue;
    }
    if (dependency.state === "merged") continue;
    const recorded = pulls.get(key);
    if (dependency.state !== "pr-open" || recorded === undefined)
      return refuse(`Prerequisite ${key} has no implemented open PR.`);
    parents.push({ assignment: key, number: recorded.number, branch: recorded.branch });
  }
  return parents.length === 0
    ? refuse("No implemented OPEN prerequisite was selected.")
    : Ok(parents);
}

/** Supplemental links live in audited base records, never in the registered source plan. */
export function stackParents(input: {
  paths: Paths;
  owner: Owner;
  additional: string[];
}): AsyncResult<Spec[], Refusal> {
  const { owner } = input;
  return WorkSources.show({
    paths: input.paths,
    cwd: owner.checkout,
    sourceId: owner.sourceId,
  }).flatMap((source) => {
    if (source === undefined) return refuse("The owned source could not be read.").toAsync();
    return DeviceState.readStackBases(input.paths, owner.repository, owner.sourceId)
      .toAsync()
      .flatMap((stored) =>
        fromThrowable(
          () => {
            const planned = source.planned.find((row) => row.key === owner.assignment);
            if (planned === undefined)
              return refuse("The owned assignment is absent from this source.");
            const bindings = stored.map((row) => ({
              assignment: row.assignment,
              parents: PrStacks.decode(row.data).parents,
            }));
            const previous =
              bindings.find((row) => row.assignment === owner.assignment)?.parents ?? [];
            const keys = [
              ...new Set([
                ...planned.dependencies,
                ...previous.map((row) => row.assignment),
                ...input.additional,
              ]),
            ];
            return cyclic(source, owner.assignment, keys, bindings)
              ? refuse("The proposed prerequisites create an assignment cycle.")
              : selected(source, keys, new Set(input.additional));
          },
          (cause, defect) =>
            cause instanceof SyntaxError || cause instanceof z.ZodError
              ? {
                  reason: "state_corrupt",
                  detail: "The recorded stack provenance is invalid. It was not repaired.",
                  next: {
                    decider: "super-agent" as const,
                    question:
                      "How should the damaged stack provenance be inspected without overwriting it?",
                  },
                }
              : defect(cause),
        )().flatMap((result): Result<Spec[], Refusal> => result),
      );
  });
}
