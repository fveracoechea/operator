import { z } from "zod";

const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

/** The positive roster has no special exclusions beyond names owned by this release. */
export function roster(documents: string[], owned: string[]) {
  const excluded = new Set(owned.map((name) => name.toLowerCase()));
  const names = documents.map((document) => {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document)?.[1];
    return z.object({ name: nameSchema }).parse(Bun.YAML.parse(String(frontmatter))).name;
  });
  return [...new Set(names)].filter((name) => !excluded.has(name)).toSorted();
}

export function commitIdentity(value: string) {
  return z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(value.trim());
}

export function installed(value: string, names: string[]) {
  try {
    const entries = z
      .array(z.object({ name: z.string(), status: z.literal("installed") }))
      .parse(JSON.parse(value));
    return names.every((name) => entries.some((entry) => entry.name === name));
  } catch {
    return false;
  }
}
