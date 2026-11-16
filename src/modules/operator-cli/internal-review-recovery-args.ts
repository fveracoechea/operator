function valuesOf(flags: string[]) {
  const values = new Map<string, string>();
  const rest = flags.values();
  for (const flag of rest) {
    if (values.has(flag)) return null;
    if (flag === "--json" || flag === "--person-instructed") values.set(flag, "");
    else if (["--source", "--assignment", "--launch", "--pr", "--head"].includes(flag)) {
      const value = rest.next().value;
      if (value === undefined || value.startsWith("--")) return null;
      values.set(flag, value);
    } else return null;
  }
  return values;
}

/** Recovery attests authority and pins the retained implementer, associated PR, and pushed head. */
export function recoveryArgs(flags: string[]) {
  const values = valuesOf(flags);
  if (values === null) return null;
  const sourceId = values.get("--source");
  const assignment = values.get("--assignment");
  const launchId = values.get("--launch");
  const number = Number(values.get("--pr"));
  const head = values.get("--head") ?? "";
  if (
    sourceId === undefined ||
    assignment === undefined ||
    launchId === undefined ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[a-f0-9]{40}$/.test(head)
  )
    return null;
  return {
    operation: "internal_review_recover" as const,
    sourceId,
    assignment,
    launchId,
    number,
    head,
    personInstructed: values.has("--person-instructed"),
  };
}
