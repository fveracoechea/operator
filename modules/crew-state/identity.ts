/** Orders object keys so two equal values always hash to the same identity. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function identityOf(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** An assignment is named by its source and its key inside that source, so it cannot duplicate. */
export function assignmentId(sourceId: string, sourceKey: string): string {
  return identityOf({ sourceId, sourceKey }).slice(0, 32);
}
