/** Guides name skills in code spans or relative SKILL.md links, never by unmarked prose. */
export function guideReferences(text: string) {
  const references = new Map<string, { name: string; link: string | null }>();
  for (const match of text.matchAll(/`([a-z][a-z0-9-]*)`/g)) {
    const name = String(match[1]);
    references.set(name, { name, link: null });
  }
  for (const match of text.matchAll(
    /(?:`|\]\()((?:\.\.\/)+([a-z][a-z0-9-]*)\/SKILL\.md)(?:`|\))/g,
  )) {
    const name = String(match[2]);
    references.set(name, { name, link: String(match[1]) });
  }
  return [...references.values()];
}
