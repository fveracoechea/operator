import { settingsSchema, type DeviceConfig } from "./schema.ts";

export type Edit = { path: string; value: string | null };

export function parseEdits(sets: string[], unsets: string[]) {
  const edits: Edit[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [action, values] of [
    ["set", sets],
    ["unset", unsets],
  ] as const) {
    for (const raw of values) {
      const separator = raw.indexOf("=");
      const key = action === "set" ? raw.slice(0, separator) : raw;
      const value = action === "set" ? raw.slice(separator + 1) : null;
      if (!/^(superAgent|workerAgent)\.(host|model|reasoningEffort)$/.test(key)) {
        issues.push(`Unsupported settings field: ${raw}.`);
      } else if (seen.has(key)) {
        issues.push(`Settings field ${key} was named more than once.`);
      } else if (action === "set" && (separator < 1 || !value?.trim())) {
        issues.push(`Set ${key} with a non-empty path=value argument.`);
      } else {
        edits.push({ path: key, value });
        seen.add(key);
      }
    }
  }
  if (sets.length + unsets.length === 0) issues.push("Name at least one --set or --unset field.");
  return issues.length > 0
    ? { issues }
    : { edits: edits.toSorted((a, b) => a.path.localeCompare(b.path)) };
}

export function editConfig(config: DeviceConfig, edits: Edit[]) {
  const next = structuredClone(config);
  for (const edit of edits) {
    const [role, field] = edit.path.split(".");
    const fields: Record<string, unknown> =
      role === "superAgent" ? next.superAgent : next.workerAgent;
    if (field === undefined) continue;
    if (edit.value === null) delete fields[field];
    else fields[field] = edit.value;
  }
  return settingsSchema.safeParse(next);
}
