import { eq } from "drizzle-orm";
import { z } from "zod";
import { IntegrationBranch } from "../integration-branch/main.ts";
import { OperativeDispatch } from "../operative-dispatch/main.ts";
import { ProjectGate } from "../project-gate/main.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import type { AttemptContext } from "./dispatch.ts";
import { readState, type StateFailure } from "./operations.ts";
import type { GateRead } from "./result-checks.ts";
import { currentLandingOf, type LandingRow } from "./landing-record.ts";
import { integrationBranches } from "./schema.ts";
import { readStored } from "./stored.ts";
import { identityOf } from "./identity.ts";

export type IntegrationBranchRow = typeof integrationBranches.$inferSelect;

const SLUG_LENGTH = 40;
// An id of this shape reads back from its slug, because only the two separators become dashes.
const PLAIN_SOURCE_ID = /^[a-z0-9]+\/[a-z0-9]+#[0-9]+$/;

/**
 * The slug of one source, the last part of each branch that Operator names for it. Two sources
 * never share a slug: an id that loses a part in the slug, by its punctuation or by the length
 * cut, ends with a short identity of the whole id.
 */
export function sourceSlug(sourceId: string): string {
  const id = sourceId.toLowerCase();
  const readable = id.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (PLAIN_SOURCE_ID.test(id) && readable.length <= SLUG_LENGTH) {
    return readable;
  }
  const kept = readable.slice(0, SLUG_LENGTH - 9).replaceAll(/-+$/g, "");
  const short = identityOf(id).slice(0, 8);
  return kept === "" ? short : `${kept}-${short}`;
}

export function integrationBranchOf(db: CrewReader, sourceId: string): IntegrationBranchRow | null {
  return (
    db
      .select()
      .from(integrationBranches)
      .where(eq(integrationBranches.sourceId, sourceId))
      .all()[0] ?? null
  );
}

const fixedCommandsSchema = z.array(
  z.strictObject({ name: z.string(), argv: z.array(z.string()), timeoutSeconds: z.number() }),
);

/**
 * The gate declaration fixed on a source with its integration base (ADR 0021). A result can change
 * the declaration file, and the change counts only for a later source, so every brief and every
 * submit check of the source reads this one and never the file at the base of an attempt.
 */
export function fixedGateOf(row: IntegrationBranchRow): Extract<GateRead, { status: "declared" }> {
  return {
    status: "declared",
    commit: row.baseCommit,
    path: ProjectGate.path(),
    identity: row.gateIdentity,
    commands: readStored("fixed gate command list", fixedCommandsSchema, row.gateCommands),
  };
}

/** The gate an attempt of one source reads: the fixed one, or the one at its own base commit. */
export async function gateOfAttempt(request: {
  projectRoot: string;
  sourceId: string;
  baseCommit: string;
}): Promise<GateRead> {
  const row = await readState(request.projectRoot, (db) =>
    integrationBranchOf(db, request.sourceId),
  );
  if (row !== null && !("status" in row)) {
    return fixedGateOf(row);
  }
  return ProjectGate.read({ repository: request.projectRoot, commit: request.baseCommit });
}

/**
 * The skill copies a new launch of one source keeps from its commit. The person approved the
 * integration base, so a copy that crew work changed after it is work under review. A source
 * with no branch yet launches from the base its first code dispatch fixes, so it keeps none.
 */
export async function committedSkillsOf(request: {
  projectRoot: string;
  sourceId: string;
  agentHost: string | null;
  commit: string;
}): Promise<
  | { status: "ok"; committed: Awaited<ReturnType<typeof OperativeDispatch.committedSkills>> }
  | StateFailure
> {
  const row = await readState(request.projectRoot, (db) =>
    integrationBranchOf(db, request.sourceId),
  );
  if (row !== null && "status" in row) {
    return row;
  }
  return {
    status: "ok",
    committed:
      row === null
        ? []
        : await OperativeDispatch.committedSkills({
            projectRoot: request.projectRoot,
            agentHost: request.agentHost,
            integrationBase: row.baseCommit,
            commit: request.commit,
          }),
  };
}

/** What the first code dispatch fixes on its source, after its base passed the project gate. */
export type IntegrationFix = {
  name: string;
  commit: string;
  gate: Extract<GateRead, { status: "declared" }>;
};

/**
 * Records the branch that the first code dispatch created. A repeat of it changes nothing. A
 * name that another source records fails the change, so no source loses its record in silence.
 */
export function recordIntegrationBranch(
  db: CrewWriter,
  request: { sourceId: string; fix: IntegrationFix; now: string },
): void {
  db.insert(integrationBranches)
    .values({
      sourceId: request.sourceId,
      name: request.fix.name,
      baseCommit: request.fix.commit,
      recordedTip: request.fix.commit,
      gateIdentity: request.fix.gate.identity,
      gateCommands: JSON.stringify(request.fix.gate.commands),
      fixedAt: request.now,
      updatedAt: request.now,
    })
    .onConflictDoNothing({ target: integrationBranches.sourceId })
    .run();
}

/**
 * The refusals of a production dispatch against the integration branch of its source, members
 * of the durable unions of ADR 0011. Operator never resets the branch and never adopts a tip it
 * did not record, so a person puts a moved branch back.
 */
export type IntegrationRefusal =
  | {
      status: "integration-branch-moved";
      attemptId: string;
      branch: string;
      recordedTip: string;
      found: string | null;
      checkedOut: string[];
    }
  | {
      status: "dispatch-base-not-tip";
      attemptId: string;
      branch: string;
      recordedTip: string;
      requested: string;
    }
  | {
      status: "integration-branch-exists";
      attemptId: string;
      branch: string;
      base: string;
      found: string;
    }
  // Another source records this name, so this source can never record it.
  | { status: "integration-branch-held"; attemptId: string; branch: string; heldBy: string }
  | { status: "integration-branch-unread"; attemptId: string; branch: string; detail: string };

/**
 * The commit a production dispatch on a recorded branch starts from, or null to leave the base to
 * the rules of its cycle. A recorded launch fixed its base already, and a rework cycle that is not
 * an integration cycle starts where its own rule says. An integration cycle starts from the
 * commit its result lands on: the recorded tip, or the parent of the commit it replaces (ADR 0008).
 */
function startOf(
  context: AttemptContext,
  row: IntegrationBranchRow,
  replaced: LandingRow | null,
  planned: boolean,
): string | null {
  const { role } = context;
  if (planned || (role.kind === "rework" && role.rework.brief.reason !== "integration")) {
    return null;
  }
  const replaces = role.kind === "rework" && role.rework.brief.integration?.replaces !== undefined;
  return replaces && replaced !== null ? replaced.landedParent : row.recordedTip;
}

/**
 * Where one production dispatch starts (ADR 0020). A source with a recorded branch first proves
 * that the branch still holds its recorded tip. A new launch of a first attempt then starts from
 * that tip, and a commit that differs refuses. An integration cycle starts there too. Every other
 * rework cycle keeps the start its cycle names, and a review or planning attempt reads no branch. `start` null leaves the base to those rules.
 */
export async function integrationStart(request: {
  projectRoot: string;
  context: AttemptContext;
  attemptId: string;
  requested: string | null;
  planned: boolean;
}): Promise<{ status: "ok"; start: string | null } | IntegrationRefusal | StateFailure> {
  const { assignment } = request.context;
  if (assignment.kind !== "production") {
    return { status: "ok", start: null };
  }
  const recorded = await readState(request.projectRoot, (db) => ({
    row: integrationBranchOf(db, assignment.sourceId),
    // An integration cycle of a correction lands in the place of the commit that carries the
    // result now, so it starts from the parent of that commit (ADR 0008, ADR 0020).
    replaced: currentLandingOf(db, assignment.id),
  }));
  if ("status" in recorded) {
    return recorded;
  }
  const { row } = recorded;
  if (row === null) {
    return { status: "ok", start: null };
  }

  const read = await IntegrationBranch.read({
    repoRoot: request.projectRoot,
    name: row.name,
    recordedTip: row.recordedTip,
  });
  if (read.status === "unread") {
    return {
      status: "integration-branch-unread",
      attemptId: request.attemptId,
      branch: row.name,
      detail: read.detail,
    };
  }
  if (read.status === "tip-moved") {
    return {
      status: "integration-branch-moved",
      attemptId: request.attemptId,
      branch: row.name,
      recordedTip: row.recordedTip,
      found: read.found,
      checkedOut: read.checkedOut,
    };
  }

  const lands = startOf(request.context, row, recorded.replaced, request.planned);
  if (lands === null) {
    return { status: "ok", start: null };
  }
  if (request.requested !== null && request.requested !== lands) {
    const resolved = await IntegrationBranch.resolve({
      repoRoot: request.projectRoot,
      commit: request.requested,
    });
    if (resolved.status !== "resolved" || resolved.commit !== lands) {
      return {
        status: "dispatch-base-not-tip",
        attemptId: request.attemptId,
        branch: row.name,
        recordedTip: lands,
        requested: request.requested,
      };
    }
  }
  return { status: "ok", start: lands };
}

/**
 * Creates the integration branch at the base of the first code dispatch of a source, after that
 * base passed the project gate. A branch that already holds another commit is never taken over.
 */
export async function createIntegrationBranch(request: {
  projectRoot: string;
  sourceId: string;
  attemptId: string;
  commit: string;
  gate: Extract<GateRead, { status: "declared" }>;
}): Promise<{ status: "created"; fix: IntegrationFix } | IntegrationRefusal | StateFailure> {
  const name = IntegrationBranch.nameOf({ sourceSlug: sourceSlug(request.sourceId) });
  const holder = await readState(request.projectRoot, (db) =>
    db.select().from(integrationBranches).where(eq(integrationBranches.name, name)).all(),
  );
  if ("status" in holder) {
    return holder;
  }
  const heldBy = holder.find((one) => one.sourceId !== request.sourceId)?.sourceId;
  if (heldBy !== undefined) {
    return {
      status: "integration-branch-held",
      attemptId: request.attemptId,
      branch: name,
      heldBy,
    };
  }
  const created = await IntegrationBranch.create({
    repoRoot: request.projectRoot,
    name,
    commit: request.commit,
  });
  if (created.status === "exists") {
    return {
      status: "integration-branch-exists",
      attemptId: request.attemptId,
      branch: name,
      base: request.commit,
      found: created.found,
    };
  }
  if (created.status === "failed") {
    return {
      status: "integration-branch-unread",
      attemptId: request.attemptId,
      branch: name,
      detail: created.detail,
    };
  }
  return { status: "created", fix: { name, commit: request.commit, gate: request.gate } };
}
