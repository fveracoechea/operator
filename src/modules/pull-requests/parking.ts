import { ErrAsync, Ok, OkAsync, fromPromise, type AsyncResult, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { readTextInput } from "../../lib/read-text-input.ts";
import { qualify, type Owner, type Paths } from "./owner.ts";
import { startHandoff, worktreeFacts } from "./internal-review.ts";
import { observeParkedPullRequests, type Observation } from "./github.ts";
import type { Refusal } from "../../lib/cli-result.ts";
import { decideWait, progressSchema } from "./wait-machine.ts";
import { relaySchema } from "./relay.ts";
import { verifiedMerge } from "./merge-machine.ts";
import { WorkSources } from "../work-sources/main.ts";
import { cleanup } from "./cleanup.ts";

export function readParkNote(file?: string): AsyncResult<string | null, Refusal> {
  return fromPromise(
    () => (file === undefined ? Promise.resolve(null) : readTextInput(file)),
    qualify,
  ).flatMap((note) =>
    note !== null && note.trimEnd().split(/\r?\n/).length > 60
      ? ErrAsync({
          reason: "pr_note_invalid",
          detail: "A park note has at most 60 lines. Nothing changed.",
          next: { command: "operator pr wait --note <file|->", why: "Shorten the park note." },
        })
      : OkAsync(note),
  );
}

type Parked = NonNullable<
  Extract<ReturnType<typeof DeviceState.claimParkedRead>, { tag: "Ok" }>["value"]
>["rows"][number];
type BatchObservation = Extract<
  Awaited<ReturnType<typeof observeParkedPullRequests>>,
  { tag: "Ok" }
>["value"][number];

/** The same observation decision advances both live-wait and parked cursors. */
export function parkedObservation(row: Parked, facts: BatchObservation) {
  const relay = row.relay === null ? null : relaySchema.parse(JSON.parse(row.relay));
  const progress = progressSchema.parse(JSON.parse(row.progress));
  const decision = decideWait({
    progress,
    observed: facts.observed,
    stackRelayed: relay === null || relay.state === "relayed",
    reviewEnded: row.readiness !== null,
  });
  const events =
    decision.result === "reported"
      ? decision.events
          .filter((event) => event.kind !== "pr_merged" && event.kind !== "pr_closed")
          .map((event) => JSON.stringify(event))
      : [];
  const parentMerged =
    relay !== null &&
    relay.state !== "relayed" &&
    facts.parent?.state === "MERGED" &&
    !row.parking.parentSeen;
  if (parentMerged)
    events.push(
      JSON.stringify({
        kind: "parent_merged",
        parent: relay.parent,
        head: facts.parent?.head,
        base: facts.parent?.base,
      }),
    );
  return {
    sourceId: row.sourceId,
    assignment: row.assignment,
    previous: JSON.stringify(row.parking),
    progress: decision.progress === undefined ? row.progress : JSON.stringify(decision.progress),
    parking: {
      ...row.parking,
      state: facts.observed.state === "CLOSED" ? ("closed" as const) : row.parking.state,
      events: [...row.parking.events, ...events],
      parentSeen: row.parking.parentSeen || parentMerged,
    },
  };
}

/** A claimed device batch records cursors and durable events before any resumed worker can start. */
export function observeParked(input: { paths: Paths }): AsyncResult<undefined, Refusal> {
  return DeviceState.claimParkedRead(input.paths)
    .toAsync()
    .flatMap((claim): AsyncResult<undefined, Refusal> => {
      if (claim === null) return OkAsync(undefined);
      return fromPromise(async () => {
        const primary = await fromPromise(async () => {
          if (claim.rows.length === 0)
            return DeviceState.finishParkedRead(input.paths, claim.at, []).map(() => undefined);
          const observed = await observeParkedPullRequests(
            claim.rows.map((row) => ({
              repository: row.repository,
              number: row.number,
              parent:
                row.relay === null ? null : relaySchema.parse(JSON.parse(row.relay)).parent.number,
            })),
          );
          if (observed.tag !== "Ok") return observed.map(() => undefined);
          const updates: ReturnType<typeof parkedObservation>[] = [];
          for (const [index, row] of claim.rows.entries()) {
            const facts = observed.value[index];
            if (facts === undefined) return Ok(undefined);
            updates.push(parkedObservation(row, facts));
          }
          const recorded = DeviceState.finishParkedRead(input.paths, claim.at, updates);
          if (recorded.tag !== "Ok") return recorded.map(() => undefined);
          if (!recorded.value) return Ok(undefined);
          for (const [index, row] of claim.rows.entries()) {
            const facts = observed.value[index];
            if (facts === undefined) continue;
            const merged = verifiedMerge(facts.observed, row.parking.head);
            if (merged === null) continue;
            const saved = DeviceState.recordPullRequestMerge(
              input.paths,
              row.parking.launchId,
              { number: row.number, ...merged },
              (rows) => WorkSources.stateAfter(rows),
            );
            if (saved.tag !== "Ok") return saved.map(() => undefined);
            const owners = DeviceState.worktreeOwners(input.paths);
            if (owners.tag !== "Ok") return owners.map(() => undefined);
            const owner = owners.value.find((owner) => owner.launchId === row.parking.launchId);
            if (owner === undefined) continue;
            const cleaned = await cleanup({
              paths: input.paths,
              cwd: owner.checkout,
              sourceId: row.sourceId,
              assignment: row.assignment,
              personInstructed: false,
            });
            if (cleaned.tag !== "Ok") return cleaned.map(() => undefined);
          }
          return Ok(undefined);
        }, qualify).flatMap((result) => result);
        const released = await fromPromise(
          () => Promise.resolve(DeviceState.finishParkedRead(input.paths, claim.at, null)),
          qualify,
        )
          .flatMap((result) => result)
          .map(() => undefined);
        return retainPrimary(primary, released, "parked_read_release", { at: claim.at });
      }, qualify).flatMap((result) => result);
    });
}

/** A quiet wait never retains a note unless it commits a parking transition. */
export function parkQuietWait(
  input: { paths: Paths; parkNote?: string | null },
  owner: Owner,
  observed: Observation,
): AsyncResult<boolean, Refusal> {
  return worktreeFacts(owner.worktreePath).flatMap((tree): AsyncResult<boolean, Refusal> => {
    if (
      tree.localHead === null ||
      (tree.localHead === observed.head &&
        (!observed.checksComplete || observed.checks.length === 0))
    )
      return ErrAsync({
        reason: "pr_checks_unknown",
        detail:
          "The pushed head or its complete check set could not be verified. The worker remains active; no park note was retained.",
        next: {
          command: "operator pr wait",
          why: "Read complete checks before parking this worker.",
        },
      });
    if (
      tree.localHead === observed.head &&
      observed.checks.some((check) => check.state === "pending")
    ) {
      return DeviceState.recordPullRequestWait(input.paths, owner.launchId, (row) => ({
        progress: row.progress,
        waitState: "idle",
      }))
        .toAsync()
        .map(() => false);
    }
    const files = OperatorHome.assignmentFiles(input.paths, {
      repository: owner.repository,
      sourceId: owner.sourceId,
      assignment: owner.assignment,
    });
    const note =
      input.parkNote === null || input.parkNote === undefined
        ? null
        : `${files.directory}/park-${crypto.randomUUID()}.md`;
    return fromPromise(async () => {
      const staged = await fromPromise(async () => {
        if (note !== null) await Bun.write(note, input.parkNote ?? "", { createPath: true });
        return undefined;
      }, qualify);
      const parked = staged.flatMap(() =>
        DeviceState.parkPullRequest(input.paths, owner.launchId, {
          head: observed.head,
          note,
        }),
      );
      if (parked.tag !== "Ok" && note !== null) {
        const removed = await fromPromise(() => Bun.file(note).delete(), qualify);
        return retainPrimary(
          parked,
          removed.map(() => undefined),
          "park_note_cleanup",
          { note },
        );
      }
      return parked;
    }, qualify)
      .flatMap((result) => result)
      .flatMap(() => startHandoff(input.paths, owner))
      .map(() => true);
  });
}

function retainPrimary<T>(
  primary: Result<T, Refusal>,
  secondary: Result<undefined, Refusal>,
  operation: string,
  state: Record<string, unknown>,
): Result<T, Refusal> {
  if (secondary.tag === "Ok") return primary;
  if (primary.tag === "Ok") return secondary.flatMap(() => primary);
  console.error(operation, { ...state, secondary });
  return primary;
}
