// Bun has no path manipulation API.
import { basename, resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AssignmentRow } from "./assignment.ts";
import { readAssignment } from "./assignment.ts";
import type { CrewReader, CrewWriter } from "./database.ts";
import { identityOf } from "./identity.ts";
import { type InvalidInput, parseInput } from "./input.ts";
import {
  type PlanningEntryInput,
  planningRecordInputSchema,
  type StoredEntry,
  storedEntrySchema,
  type StoredPlanningArtifact,
  storedPlanningArtifactSchema,
} from "./planning-input.ts";
import { type EscalationTrigger, unclosedBy } from "./question-input.ts";
import {
  copyRefusal,
  type PreparedSource,
  prepareSource,
  type QuoteOutcome,
  quoteSource,
  type RecordedSource,
  storeSource,
} from "./requirement-source.ts";
import { assignmentDependencies, planningRecords } from "./schema.ts";
import { readVerified, type VerifiedRead } from "./verified-copy.ts";
import { readStored } from "./stored.ts";
import { isExecutable, type PlanningType } from "./work-input.ts";

/**
 * The planning home of the artifact store. A copy is named by its content, so the same text
 * recorded twice is one file, and a repeated request writes the same bytes again.
 */
export const PLANNING_STORE = ".operator/local/planning";

/**
 * The only planning type whose decisions may rest on an Operator decision, because its result is
 * findings and not a choice for the user.
 */
const OPERATOR_DECISION_TYPE: PlanningType = "research";

type PreparedEntry = { input: PlanningEntryInput; source: PreparedSource | null };

/** A planning record whose sources and artifacts are read, checked, and stored. */
export type PreparedRecord = { entries: PreparedEntry[]; artifacts: StoredPlanningArtifact[] };

/** Each refusal names the entry it is about by its place in the record, from 1. */
export type PrepareRecordOutcome =
  | { status: "prepared"; record: PreparedRecord }
  | InvalidInput
  | { status: "source-unreadable"; entry: number; path: string }
  | { status: "source-not-text"; entry: number; path: string }
  | { status: "quote-not-in-source"; entry: number; source: RecordedSource }
  | { status: "artifact-unreadable"; name: string; path: string }
  | { status: "artifact-identity-changed"; name: string; path: string; found: string };

type ArtifactRefusal =
  | { status: "artifact-unreadable"; name: string; path: string }
  | { status: "artifact-identity-changed"; name: string; path: string; found: string };

function artifactRefusal(
  read: Exclude<VerifiedRead, { status: "read" }>,
  artifact: { name: string; path: string },
): ArtifactRefusal {
  return read.status === "unreadable"
    ? { status: "artifact-unreadable", ...artifact }
    : { status: "artifact-identity-changed", ...artifact, found: read.found };
}

function isText(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads one planning record request and checks everything that needs no crew state: each file
 * source holds its quote, and each artifact holds the content identity it states. Only then does
 * it store the copies, so a refused record leaves nothing behind.
 */
export async function preparePlanningRecord(request: {
  projectRoot: string;
  input: unknown;
}): Promise<PrepareRecordOutcome> {
  const parsed = parseInput(planningRecordInputSchema, request.input);
  if (parsed.status !== "parsed") {
    return parsed;
  }

  const entries: PreparedEntry[] = [];
  for (const [index, input] of parsed.value.entries.entries()) {
    const entry = index + 1;
    if (input.authority !== "requirement") {
      entries.push({ input, source: null });
      continue;
    }

    const prepared = await prepareSource({
      projectRoot: request.projectRoot,
      source: input.source,
    });
    if (prepared.status !== "prepared") {
      return { ...prepared, entry };
    }
    const refused = copyRefusal({ source: prepared.source, exactText: input.exactText });
    if (refused !== null) {
      return { ...refused, entry };
    }
    entries.push({ input, source: prepared.source });
  }

  const artifacts: Array<StoredPlanningArtifact & { bytes: Uint8Array }> = [];
  for (const artifact of parsed.value.artifacts) {
    const read = await readVerified(
      resolve(request.projectRoot, artifact.path),
      artifact.contentIdentity,
    );
    if (read.status !== "read") {
      return artifactRefusal(read, { name: artifact.name, path: artifact.path });
    }
    artifacts.push({
      name: artifact.name,
      contentIdentity: artifact.contentIdentity,
      storedPath: `${PLANNING_STORE}/${artifact.contentIdentity}`,
      text: isText(read.bytes),
      bytes: read.bytes,
    });
  }

  for (const entry of entries) {
    if (entry.source !== null) {
      await storeSource({ projectRoot: request.projectRoot, source: entry.source });
    }
  }
  for (const artifact of artifacts) {
    await Bun.write(`${request.projectRoot}/${artifact.storedPath}`, artifact.bytes, {
      createPath: true,
    });
  }

  return {
    status: "prepared",
    record: {
      entries,
      artifacts: artifacts.map(({ bytes: _bytes, ...stored }) => stored),
    },
  };
}

export type RecordRefusal =
  | {
      status: "operator-decision-not-allowed";
      assignmentId: string;
      entry: number;
      planningType: string | null;
    }
  | {
      status: "escalation-required";
      assignmentId: string;
      entry: number;
      authority: string;
      escalationTriggers: EscalationTrigger[];
    }
  | { status: "quote-not-in-source"; entry: number; source: RecordedSource }
  | { status: "source-assignment-unknown"; entry: number; assignmentId: string }
  | { status: "source-unknown"; entry: number; sourceId: string }
  | {
      status: "source-revision-changed";
      entry: number;
      sourceId: string;
      revision: string;
      recorded: string;
    };

/**
 * Checks each decision against the authority the planning work may have.
 * A grilling, a prototype, and planning work with no type are the human side of a decision, so
 * none of their decisions is an Operator decision, whatever subjects the Operator declares.
 */
export function checkPlanningRecord(
  db: CrewReader,
  request: { row: AssignmentRow; record: PreparedRecord },
): { status: "checked"; entries: StoredEntry[] } | RecordRefusal {
  const entries: StoredEntry[] = [];
  for (const [index, { input, source }] of request.record.entries.entries()) {
    const entry = index + 1;
    if (
      input.authority === "operator-decision" &&
      request.row.planningType !== OPERATOR_DECISION_TYPE
    ) {
      return {
        status: "operator-decision-not-allowed",
        assignmentId: request.row.id,
        entry,
        planningType: request.row.planningType,
      };
    }

    const unclosed = unclosedBy(input.authority, input.escalationTriggers);
    if (unclosed.length > 0) {
      return {
        status: "escalation-required",
        assignmentId: request.row.id,
        entry,
        authority: input.authority,
        escalationTriggers: unclosed,
      };
    }

    let recorded: RecordedSource | null = null;
    if (input.authority === "requirement" && source !== null) {
      const quoted: QuoteOutcome = quoteSource(db, { source, exactText: input.exactText });
      if (quoted.status === "unknown-assignment") {
        return { status: "source-assignment-unknown", entry, assignmentId: quoted.assignmentId };
      }
      if (quoted.status !== "quoted") {
        return { ...quoted, entry };
      }
      recorded = quoted.source;
    }

    entries.push({
      question: input.question,
      escalationTriggers: input.escalationTriggers,
      authority: input.authority,
      exactText: input.authority === "operator-decision" ? null : input.exactText,
      source: recorded,
      interpretation: input.interpretation,
    });
  }

  return { status: "checked", entries };
}

/** Writes one accepted planning record. Nothing changes it later. */
export function insertPlanningRecord(
  db: CrewWriter,
  request: {
    assignmentId: string;
    assignmentRevision: number;
    entries: StoredEntry[];
    artifacts: StoredPlanningArtifact[];
    now: string;
  },
): string {
  const id = crypto.randomUUID();
  db.insert(planningRecords)
    .values({
      id,
      assignmentId: request.assignmentId,
      assignmentRevision: request.assignmentRevision,
      entries: JSON.stringify(request.entries),
      artifacts: JSON.stringify(request.artifacts),
      identity: identityOf({ entries: request.entries, artifacts: request.artifacts }),
      recordedAt: request.now,
    })
    .run();
  return id;
}

export type PlanningRecord = {
  recordId: string;
  assignmentId: string;
  assignmentRevision: number;
  identity: string;
  entries: StoredEntry[];
  artifacts: StoredPlanningArtifact[];
  recordedAt: string;
};

function recordOf(row: typeof planningRecords.$inferSelect): PlanningRecord {
  return {
    recordId: row.id,
    assignmentId: row.assignmentId,
    assignmentRevision: row.assignmentRevision,
    identity: row.identity,
    entries: readStored("planning entry list", z.array(storedEntrySchema), row.entries),
    artifacts: readStored(
      "planning artifact list",
      z.array(storedPlanningArtifactSchema),
      row.artifacts,
    ),
    recordedAt: row.recordedAt,
  };
}

/** Every record of one planning assignment, oldest first. Nothing removes an earlier one. */
export function planningRecordsOf(db: CrewReader, assignmentId: string): PlanningRecord[] {
  return db
    .select()
    .from(planningRecords)
    .where(eq(planningRecords.assignmentId, assignmentId))
    .orderBy(asc(planningRecords.assignmentRevision))
    .all()
    .map(recordOf);
}

/** The record of the latest acceptance of one planning assignment, or null when it has none. */
export function latestPlanningRecord(db: CrewReader, assignmentId: string): PlanningRecord | null {
  return planningRecordsOf(db, assignmentId).at(-1) ?? null;
}

/**
 * A short pointer to the record of one direct planning dependency.
 * The Operator reads it, so it holds no words of the decision: the crew reads the full record
 * with the command it names. Planning work that an earlier release accepted keeps no record, so
 * its record fields are null and a reader does not take the absence for "no decision was needed".
 */
export type DependencyRecord = {
  assignmentId: string;
  title: string;
  recordId: string | null;
  identity: string | null;
  entryCount: number;
  command: string;
};

export function dependencyRecords(db: CrewReader, assignmentId: string): DependencyRecord[] {
  return db
    .select()
    .from(assignmentDependencies)
    .where(eq(assignmentDependencies.assignmentId, assignmentId))
    .all()
    .flatMap((edge) => {
      const row = readAssignment(db, edge.dependsOnId);
      if (row === null || isExecutable(row.kind)) {
        return [];
      }
      const record = latestPlanningRecord(db, row.id);
      return [
        {
          assignmentId: row.id,
          title: row.title,
          recordId: record?.recordId ?? null,
          identity: record?.identity ?? null,
          entryCount: record?.entries.length ?? 0,
          command: `operator work record --assignment ${row.id}`,
        },
      ];
    })
    .toSorted((left, right) => left.assignmentId.localeCompare(right.assignmentId));
}

export type ShowRecordResult =
  | { status: "reported"; record: PlanningRecord; recordIds: string[] }
  | { status: "unknown-assignment"; assignmentId: string }
  | { status: "planning-record-missing"; assignmentId: string; recordId: string | null };

/**
 * Reads one planning record in full, for the crew that prepares dependent planning work.
 * It names the latest record unless a record identity is given, and it lists every record id,
 * so an earlier decision stays readable after a new acceptance.
 */
export function showPlanningRecord(
  db: CrewReader,
  request: { assignmentId: string; recordId: string | null },
): ShowRecordResult {
  if (readAssignment(db, request.assignmentId) === null) {
    return { status: "unknown-assignment", assignmentId: request.assignmentId };
  }

  const records = planningRecordsOf(db, request.assignmentId);
  // The latest record is the one a dependent receives, so this read names it the same way.
  const record =
    request.recordId === null
      ? latestPlanningRecord(db, request.assignmentId)
      : records.find((one) => one.recordId === request.recordId);
  return record === undefined || record === null
    ? {
        status: "planning-record-missing",
        assignmentId: request.assignmentId,
        recordId: request.recordId,
      }
    : { status: "reported", record, recordIds: records.map((one) => one.recordId) };
}

const AUTHORITY_LABELS = {
  requirement: "requirement",
  "human-answer": "human answer",
  "operator-decision": "Operator decision",
} as const;

/**
 * Names a source without a local path. A copy is named by its file name and fixed by its
 * revision, so a path in a home folder never reaches the tracker.
 */
function sourceLabel(source: RecordedSource): string {
  if (source.kind === "approved-scope") {
    return `the approved scope of \`${source.id}\` at revision \`${source.revision}\``;
  }
  return source.kind === "source-revision"
    ? `the work source \`${source.id}\` at revision \`${source.revision}\``
    : `\`${basename(source.id)}\` at revision \`${source.revision}\``;
}

function renderEntry(entry: StoredEntry, place: number): string[] {
  const authority =
    entry.source === null
      ? AUTHORITY_LABELS[entry.authority]
      : `${AUTHORITY_LABELS[entry.authority]}, quoted from ${sourceLabel(entry.source)}`;
  return [
    `### Decision ${place}`,
    "",
    `**Question:** ${entry.question}`,
    "",
    `**Authority:** ${authority}`,
    ...(entry.escalationTriggers.length === 0
      ? []
      : ["", `**Escalation triggers:** ${entry.escalationTriggers.join(", ")}`]),
    ...(entry.exactText === null
      ? []
      : ["", ...entry.exactText.split("\n").map((line) => (line === "" ? ">" : `> ${line}`))]),
    "",
    `**Summary:** ${entry.interpretation.summary}`,
    "",
    "**Directives:**",
    "",
    ...entry.interpretation.directives.map((one) => `- ${one}`),
    "",
    "**Applies to:**",
    "",
    ...entry.interpretation.appliesTo.map((one) => `- ${one}`),
  ];
}

export type RenderOutcome = { status: "rendered"; body: string } | ArtifactRefusal;

/**
 * Renders the tracker resolution of planning work from its record: each entry in order, then
 * the content of each text artifact in order. It takes no free text, so the tracker and the
 * brief of a dependent carry the same words.
 */
export async function renderPlanningResolution(request: {
  projectRoot: string;
  record: PlanningRecord;
}): Promise<RenderOutcome> {
  const parts = [
    [
      "## Planning record",
      ...request.record.entries.flatMap((entry, index) => ["", ...renderEntry(entry, index + 1)]),
    ].join("\n"),
  ];

  for (const artifact of request.record.artifacts.filter((one) => one.text)) {
    // The copy is checked again, so a changed store never reaches the tracker as the record.
    const read = await readVerified(
      `${request.projectRoot}/${artifact.storedPath}`,
      artifact.contentIdentity,
    );
    if (read.status !== "read") {
      return artifactRefusal(read, { name: artifact.name, path: artifact.storedPath });
    }
    parts.push(new TextDecoder("utf-8", { ignoreBOM: true }).decode(read.bytes).trimEnd());
  }

  return { status: "rendered", body: parts.join("\n\n") };
}
