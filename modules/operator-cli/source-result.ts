import type { ParsedArguments } from "./arguments.ts";
import { type Handled, type Operation, refuse } from "./result.ts";

type RecordedSource = { id: string; revision: string; storedPath: string | null };

/** A refusal of the source behind a requirement. A planning record names the entry it is in. */
type SourceRefusal =
  | { status: "source-unreadable"; path: string; entry?: number }
  | { status: "source-not-text"; path: string; entry?: number }
  | { status: "quote-not-in-source"; source: RecordedSource; entry?: number }
  | { status: "source-assignment-unknown"; assignmentId: string; entry: number }
  | { status: "source-unknown"; sourceId: string; entry?: number }
  | {
      status: "source-revision-changed";
      sourceId: string;
      revision: string;
      recorded: string;
      entry?: number;
    };

const SOURCE_STATUSES: ReadonlySet<string> = new Set<SourceRefusal["status"]>([
  "source-unreadable",
  "source-not-text",
  "quote-not-in-source",
  "source-assignment-unknown",
  "source-unknown",
  "source-revision-changed",
]);

export function isSourceRefusal<Result extends { status: string }>(
  result: Result,
): result is Extract<Result, { status: SourceRefusal["status"] }> {
  return SOURCE_STATUSES.has(result.status);
}

function where(entry: number | undefined): string {
  return entry === undefined ? "" : `Entry ${entry}: `;
}

function located(entry: number | undefined): Record<string, unknown> {
  return entry === undefined ? {} : { entry };
}

/**
 * Reports why the quote of a requirement was refused. A question answer and a planning record
 * check a quote with one gate, so they report it the same way.
 */
export function reportSourceRefusal(
  parsed: ParsedArguments,
  operation: Operation,
  refusal: SourceRefusal,
): Handled {
  if (refusal.status === "source-unreadable") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "source_unreadable",
      detail: { path: refusal.path, ...located(refusal.entry) },
      lines: [`${where(refusal.entry)}The requirement source ${refusal.path} cannot be read.`],
    });
  }

  if (refusal.status === "source-not-text") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "source_not_text",
      detail: { path: refusal.path, ...located(refusal.entry) },
      lines: [
        `${where(refusal.entry)}The requirement source ${refusal.path} is not UTF-8 text, so no quote can match it.`,
      ],
    });
  }

  if (refusal.status === "quote-not-in-source") {
    const { source } = refusal;
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "quote_not_in_source",
      detail: { source, ...located(refusal.entry) },
      // The refusal names where the source is and never prints it, so a long source costs the
      // Operator no context.
      lines: [
        `${where(refusal.entry)}The exact words do not appear in ${source.id} at revision ${source.revision}.`,
        ...(source.storedPath === null ? [] : [`The checked copy is ${source.storedPath}.`]),
        "Quote the exact bytes of the source. Do not wrap the lines again or shorten the words.",
      ],
    });
  }

  if (refusal.status === "source-unknown") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "invalid",
      reason: "unknown_source",
      detail: { sourceId: refusal.sourceId, ...located(refusal.entry) },
      lines: [
        `${where(refusal.entry)}No work source is registered as ${refusal.sourceId}, so it holds no revision to quote.`,
      ],
    });
  }

  if (refusal.status === "source-revision-changed") {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "conflict",
      reason: "source_revision_changed",
      detail: {
        sourceId: refusal.sourceId,
        revision: refusal.revision,
        recorded: refusal.recorded,
        ...located(refusal.entry),
      },
      lines: [
        `${where(refusal.entry)}The work source ${refusal.sourceId} is recorded at revision ${refusal.recorded}, not ${refusal.revision}.`,
        "Quote the recorded revision.",
      ],
    });
  }

  return refuse({
    json: parsed.json,
    operation,
    outcome: "invalid",
    reason: "unknown_assignment",
    detail: { assignmentId: refusal.assignmentId, entry: refusal.entry },
    lines: [
      `Entry ${refusal.entry}: no assignment is registered as ${refusal.assignmentId}, so it holds no approved scope.`,
    ],
  });
}
