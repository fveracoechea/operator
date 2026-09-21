import type { z } from "zod";

/**
 * Reads one stored column through the schema that wrote it.
 * Crew state is written only by this release, so a value that does not parse is a damaged
 * record rather than a shape a caller may work around. It fails loudly instead of being
 * asserted into the type the reader wanted.
 */
export function readStored<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  stored: string,
): z.infer<Schema> {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch (error) {
    throw new Error(`the crew state holds a ${name} that is not JSON: ${String(error)}`);
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`the crew state holds a ${name} this release cannot read: ${detail}`);
  }

  return parsed.data;
}

/** Reads one stored value that is not JSON, such as a bare enum column. */
export function readStoredValue<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  stored: string,
): z.infer<Schema> {
  const parsed = schema.safeParse(stored);
  if (!parsed.success) {
    throw new Error(`the crew state holds a ${name} this release cannot read: ${stored}`);
  }

  return parsed.data;
}
