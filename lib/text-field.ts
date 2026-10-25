import { z } from "zod";

export function textField(source: unknown, key: string): string | null {
  const parsed = z.object({ [key]: z.string() }).safeParse(source);
  return parsed.success ? (parsed.data[key] ?? null) : null;
}
