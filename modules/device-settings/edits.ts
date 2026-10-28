import { profileNameSchema, settingsSchema, type DeviceConfig } from "./schema.ts";

export type Edit = { path: string; value: string | null };

function validField(key: string, action: string, value: string) {
  if (/^(superAgent|workerAgent)\.(host|model|reasoningEffort)$/.test(key)) return true;
  // The optional assignment reviewer is the only boolean setting.
  if (key === "review.assignments") return action === "unset" || ["true", "false"].includes(value);
  // The settings schema validates the channel id, the repositories, and the logins.
  if (reviewEdits.has(key)) return true;
  const [group, name, field, ...extra] = key.split(".");
  if (group !== "profiles" || !profileNameSchema.safeParse(name).success || extra.length > 0)
    return false;
  return field === undefined ? action === "unset" : /^(host|model|reasoningEffort)$/.test(field);
}

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
      if (!validField(key, action, raw.slice(separator + 1))) {
        issues.push(`Unsupported settings field: ${raw}.`);
      } else if (
        seen.has(key) ||
        edits.some((edit) => edit.path.startsWith(`${key}.`) || key.startsWith(`${edit.path}.`))
      ) {
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
  for (const edit of edits) applyEdit(next, edit);
  return settingsSchema.safeParse(next);
}

function applyEdit(next: DeviceConfig, edit: Edit) {
  if (edit.path.startsWith("review.")) {
    applyReviewEdit(next, edit);
    return;
  }
  const [role, name, profileField] = edit.path.split(".");
  let field = name;
  let fields: Record<string, unknown> = role === "superAgent" ? next.superAgent : next.workerAgent;
  if (role === "profiles") {
    if (name === undefined) return;
    if (profileField === undefined) {
      if (next.profiles) delete next.profiles[name];
      return;
    }
    next.profiles ??= {};
    next.profiles[name] ??= {};
    fields = next.profiles[name];
    field = profileField;
  }
  if (field === undefined) return;
  if (edit.value === null) delete fields[field];
  else fields[field] = edit.value;
}

type Review = NonNullable<DeviceConfig["review"]>;

/** A list field takes comma-separated values. A repository identity is lowercase. */
function list(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const reviewEdits = new Map<string, (review: Review, value: string | null) => void>([
  [
    "review.assignments",
    (review, value) => {
      if (value === null) delete review.assignments;
      else review.assignments = value === "true";
    },
  ],
  [
    "review.channel",
    (review, value) => {
      if (value === null) delete review.channel;
      else review.channel = value;
    },
  ],
  [
    "review.repos",
    (review, value) => {
      if (value === null) delete review.repos;
      else review.repos = list(value).map((item) => item.toLowerCase());
    },
  ],
  [
    "review.authors",
    (review, value) => {
      if (value === null) delete review.authors;
      else review.authors = list(value);
    },
  ],
]);

function applyReviewEdit(next: DeviceConfig, edit: Edit) {
  const review = { ...next.review };
  reviewEdits.get(edit.path)?.(review, edit.value);
  next.review = review;
}
