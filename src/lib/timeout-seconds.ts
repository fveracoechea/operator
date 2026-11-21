/** Whole seconds without a host-duration cap. Refuse values JavaScript cannot represent exactly. */
export function timeoutSeconds(value: string) {
  if (!/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}
