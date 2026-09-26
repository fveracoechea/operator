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

export const ContentIdentity = {
  /** Names one structured value, independent of the key order its writer happened to use. */
  of(value: unknown): string {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(value))).digest("hex");
  },

  /** Names one file's exact bytes, so a copy can be compared against what it was meant to be. */
  ofBytes(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  },

  ofText(text: string): string {
    return new Bun.CryptoHasher("sha256").update(text).digest("hex");
  },
};
