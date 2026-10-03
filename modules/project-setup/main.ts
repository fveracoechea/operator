// Bun has no file removal API.
import { rm } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  type Journal,
  readJournal,
  SetupApply,
  type SetupApplyState,
  writeJournal,
} from "./journal.ts";
import { computePlan, readTextOrNull, type SetupPlan, type SetupTarget } from "./plan.ts";

type Refused<S extends string> = { [Status in S]: { status: Status; plan: SetupPlan } }[S];

type ApplyResult =
  | { status: "unreadable"; detail: string }
  | { status: "recovery-pending" }
  | Refused<"conflict" | "approval-required" | "approval-stale" | "unchanged">
  | {
      status: "interrupted";
      plan: SetupPlan;
      failedPath: string;
      detail: string;
      written: string[];
    }
  | { status: "applied"; plan: SetupPlan };

type RollbackResult =
  | { status: "unreadable"; detail: string }
  | { status: "nothing" }
  | { status: "complete" }
  | { status: "conflict"; restored: string[]; conflicts: Array<{ path: string; detail: string }> }
  | { status: "restored"; restored: string[] };

/** The recorded state of the setup apply, or why the record cannot be read. */
async function readState(
  projectRoot: string,
): Promise<{ state: SetupApplyState; journal: Journal | null } | { unreadable: string }> {
  const read = await readJournal(projectRoot);
  if (read.state === "unreadable") {
    return { unreadable: read.detail };
  }

  return read.state === "missing"
    ? { state: "absent", journal: null }
    : { state: read.journal.status, journal: read.journal };
}

export const ProjectSetup = {
  /** Inspects the project and reports the exact changes setup would make. Writes nothing. */
  async plan(request: { projectRoot: string; targets: SetupTarget[] }) {
    return computePlan(request.projectRoot, request.targets);
  },

  /** Writes the approved plan. A changed plan or target refuses the old approval. */
  async apply(request: {
    projectRoot: string;
    targets: SetupTarget[];
    approvedPlanId: string | undefined;
  }): Promise<ApplyResult> {
    const recorded = await readState(request.projectRoot);
    if ("unreadable" in recorded) {
      return { status: "unreadable", detail: recorded.unreadable };
    }

    const plan = await computePlan(request.projectRoot, request.targets);
    const decision = SetupApply.decide(recorded.state, "apply", {
      plan,
      approvedPlanId: request.approvedPlanId,
    });
    if ("refused" in decision) {
      return decision.refused === "recovery-pending"
        ? { status: "recovery-pending" }
        : { status: decision.refused, plan };
    }

    const journal: Journal = {
      schemaVersion: 1,
      planId: plan.planId,
      status: decision.next,
      writes: [],
    };
    await writeJournal(request.projectRoot, journal);
    // A per-file event writes the journal only when it moves the state.
    async function advance(decision: { next: Journal["status"] } | { refused: string }) {
      if ("next" in decision && decision.next !== journal.status) {
        journal.status = decision.next;
        await writeJournal(request.projectRoot, journal);
      }
    }

    const changes = decision.effects.flatMap((effect) =>
      effect.kind === "write" ? [effect.change] : [],
    );
    for (const [index, change] of changes.entries()) {
      journal.writes.push({
        path: change.path,
        existedBefore: change.previousText !== null,
        previousText: change.previousText,
        previousSha:
          change.previousText === null ? null : ContentIdentity.ofText(change.previousText),
        writtenSha: ContentIdentity.ofText(change.nextText),
      });
      // The record lands before the write, so an interruption is always recoverable.
      await writeJournal(request.projectRoot, journal);

      try {
        await Bun.write(`${request.projectRoot}/${change.path}`, change.nextText, {
          createPath: true,
        });
      } catch (error) {
        await advance(SetupApply.decide(journal.status, "write-failed", {}));
        return {
          status: "interrupted",
          plan,
          failedPath: change.path,
          detail: String(error),
          written: journal.writes.slice(0, -1).map((write) => write.path),
        };
      }

      await advance(
        SetupApply.decide(journal.status, "file-written", {
          remaining: changes.length - index - 1,
        }),
      );
    }

    return { status: "applied", plan };
  },

  /** Restores only the files that still hold what setup wrote. Later user edits stay. */
  async rollback(request: { projectRoot: string }): Promise<RollbackResult> {
    const recorded = await readState(request.projectRoot);
    if ("unreadable" in recorded) {
      return { status: "unreadable", detail: recorded.unreadable };
    }

    const writes = recorded.journal?.writes ?? [];
    const files = await Promise.all(
      writes.map(async (write) => {
        const currentText = await readTextOrNull(`${request.projectRoot}/${write.path}`);
        return {
          write,
          currentSha: currentText === null ? null : ContentIdentity.ofText(currentText),
        };
      }),
    );
    const decision = SetupApply.decide(recorded.state, "rollback", { files });
    if ("refused" in decision || recorded.journal === null) {
      return { status: "refused" in decision ? decision.refused : "nothing" };
    }

    const restored: string[] = [];
    const conflicts: Array<{ path: string; detail: string }> = [];
    for (const effect of decision.effects) {
      if (effect.kind !== "rollback") {
        continue;
      }
      const path = `${request.projectRoot}/${effect.path}`;
      if (effect.verdict === "restore") {
        await (effect.previousText === null
          ? rm(path, { force: true })
          : Bun.write(path, effect.previousText));
      }
      if (effect.verdict === "preserve") {
        conflicts.push({
          path: effect.path,
          detail: "This file changed after setup wrote it, so it was preserved.",
        });
      } else {
        restored.push(effect.path);
      }
    }

    await writeJournal(request.projectRoot, { ...recorded.journal, status: decision.next });

    return conflicts.length > 0
      ? { status: "conflict", restored, conflicts }
      : { status: "restored", restored };
  },
};
