// Bun has no file removal API.
import { rm } from "node:fs/promises";
import { readTextOrNull, sha256 } from "./files.ts";
import { type Journal, readJournal, writeJournal } from "./journal.ts";
import { computePlan, type SetupTarget } from "./plan.ts";

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
  }) {
    // A pending recovery record must be resolved first, or rollback would lose the original files.
    const recorded = await readJournal(request.projectRoot);
    if (recorded.state === "unreadable") {
      return { status: "unreadable" as const, detail: recorded.detail };
    }
    if (recorded.state === "read" && recorded.journal.status === "in-progress") {
      return { status: "recovery-pending" as const };
    }

    const plan = await computePlan(request.projectRoot, request.targets);
    if (plan.conflicts.length > 0) {
      return { status: "conflict" as const, plan };
    }
    if (request.approvedPlanId === undefined) {
      return { status: "approval-required" as const, plan };
    }
    if (request.approvedPlanId !== plan.planId) {
      return { status: "approval-stale" as const, plan };
    }
    if (plan.changes.length === 0) {
      return { status: "unchanged" as const, plan };
    }

    const journal: Journal = {
      schemaVersion: 1,
      planId: plan.planId,
      status: "in-progress",
      writes: [],
    };
    await writeJournal(request.projectRoot, journal);

    for (const change of plan.changes) {
      journal.writes.push({
        path: change.path,
        existedBefore: change.previousText !== null,
        previousText: change.previousText,
        previousSha: change.previousText === null ? null : sha256(change.previousText),
        writtenSha: sha256(change.nextText),
      });
      // The record lands before the write, so an interruption is always recoverable.
      await writeJournal(request.projectRoot, journal);

      try {
        await Bun.write(`${request.projectRoot}/${change.path}`, change.nextText, {
          createPath: true,
        });
      } catch (error) {
        return {
          status: "interrupted" as const,
          plan,
          failedPath: change.path,
          detail: String(error),
          written: journal.writes.slice(0, -1).map((write) => write.path),
        };
      }
    }

    journal.status = "complete";
    await writeJournal(request.projectRoot, journal);
    return { status: "applied" as const, plan };
  },

  /** Restores only the files that still hold what setup wrote. Later user edits stay. */
  async rollback(request: { projectRoot: string }) {
    const read = await readJournal(request.projectRoot);
    if (read.state === "missing") {
      return { status: "nothing" as const };
    }
    if (read.state === "unreadable") {
      return { status: "unreadable" as const, detail: read.detail };
    }

    const journal = read.journal;
    if (journal.status === "complete") {
      return { status: "complete" as const };
    }
    if (journal.status === "rolled-back") {
      return { status: "nothing" as const };
    }

    const restored: string[] = [];
    const conflicts: Array<{ path: string; detail: string }> = [];

    for (const entry of journal.writes.toReversed()) {
      const path = `${request.projectRoot}/${entry.path}`;
      const currentText = await readTextOrNull(path);
      const currentSha = currentText === null ? null : sha256(currentText);

      if (currentSha === entry.writtenSha) {
        if (entry.existedBefore && entry.previousText !== null) {
          await Bun.write(path, entry.previousText);
        } else {
          await rm(path, { force: true });
        }
        restored.push(entry.path);
      } else if (currentSha === entry.previousSha) {
        // The write never landed, so the file already holds its previous contents.
        restored.push(entry.path);
      } else {
        conflicts.push({
          path: entry.path,
          detail: "This file changed after setup wrote it, so it was preserved.",
        });
      }
    }

    journal.status = "rolled-back";
    await writeJournal(request.projectRoot, journal);

    if (conflicts.length > 0) {
      return { status: "conflict" as const, restored, conflicts };
    }

    return { status: "restored" as const, restored };
  },
};
