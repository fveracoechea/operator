type Answer = {
  sources: { id: string; actions: { action: string; reason?: string; assignment?: string }[] }[];
};

/**
 * The set of non-wait actions that a coordination wait compares, as stored text. Recorded facts
 * beside an action, such as observed activity or a wait time, change nothing, so only the
 * source, the assignment, the action, and its reason count.
 */
export function actionSet(answer: Answer) {
  const rows = new Map(
    answer.sources.flatMap((source) =>
      source.actions.map((row) => {
        const tuple = [source.id, row.assignment ?? null, row.action, row.reason ?? null];
        return [JSON.stringify(tuple), tuple] as const;
      }),
    ),
  );
  return JSON.stringify(
    [...rows.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([, tuple]) => tuple),
  );
}
