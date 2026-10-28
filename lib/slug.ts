/** Lowercase ASCII letters and digits joined by single hyphens, with no hyphen at either end. */
export function slug(text: string) {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}
