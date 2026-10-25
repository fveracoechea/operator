export function textField(source: unknown, key: string): string | null {
  if (source === null || typeof source !== "object") return null;
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : null;
}
