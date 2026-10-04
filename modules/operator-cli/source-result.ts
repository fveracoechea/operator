import type { Refusal } from "./result.ts";

/** A planning record names the entry that holds the refused quote. A question answer names none. */
type Located = { entry?: number };

function where(entry: number | undefined): string {
  return entry === undefined ? "" : `Entry ${entry}: `;
}

function located(entry: number | undefined): Record<string, unknown> {
  return entry === undefined ? {} : { entry };
}

/**
 * Why the quote of a requirement was refused. A question answer and a planning record check a
 * quote with one gate, so they spread this one table.
 */
export const sourceRefusals = {
  "source-unreadable": (result: Located & { path: string }): Refusal => ({
    outcome: "invalid",
    reason: "source_unreadable",
    detail: { path: result.path, ...located(result.entry) },
    lines: [`${where(result.entry)}The requirement source ${result.path} cannot be read.`],
  }),
  "source-not-text": (result: Located & { path: string }): Refusal => ({
    outcome: "invalid",
    reason: "source_not_text",
    detail: { path: result.path, ...located(result.entry) },
    lines: [
      `${where(result.entry)}The requirement source ${result.path} is not UTF-8 text, so no quote can match it.`,
    ],
  }),
  "quote-not-in-source": (
    result: Located & { source: { id: string; revision: string; storedPath: string | null } },
  ): Refusal => {
    const { source } = result;
    return {
      outcome: "invalid",
      reason: "quote_not_in_source",
      detail: { source, ...located(result.entry) },
      // The refusal names where the source is and never prints it, so a long source costs the
      // Operator no context.
      lines: [
        `${where(result.entry)}The exact words do not appear in ${source.id} at revision ${source.revision}.`,
        ...(source.storedPath === null ? [] : [`The checked copy is ${source.storedPath}.`]),
        "Quote the exact bytes of the source. Do not wrap the lines again or shorten the words.",
      ],
    };
  },
  "source-unknown": (result: Located & { sourceId: string }): Refusal => ({
    outcome: "invalid",
    reason: "unknown_source",
    detail: { sourceId: result.sourceId, ...located(result.entry) },
    lines: [
      `${where(result.entry)}No work source is registered as ${result.sourceId}, so it holds no revision to quote.`,
    ],
  }),
  "source-revision-changed": (
    result: Located & { sourceId: string; revision: string; recorded: string },
  ): Refusal => ({
    outcome: "conflict",
    reason: "source_revision_changed",
    detail: {
      sourceId: result.sourceId,
      revision: result.revision,
      recorded: result.recorded,
      ...located(result.entry),
    },
    lines: [
      `${where(result.entry)}The work source ${result.sourceId} is recorded at revision ${result.recorded}, not ${result.revision}.`,
      "Quote the recorded revision.",
    ],
  }),
  "source-assignment-unknown": (result: { assignmentId: string; entry: number }): Refusal => ({
    outcome: "invalid",
    reason: "unknown_assignment",
    detail: { assignmentId: result.assignmentId, entry: result.entry },
    lines: [
      `Entry ${result.entry}: no assignment is registered as ${result.assignmentId}, so it holds no approved scope.`,
    ],
  }),
};
