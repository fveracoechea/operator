// A shipped file resolves its neighbours by the name they are published under, so every relative
// TypeScript specifier becomes a JavaScript one. Bare specifiers stay untouched, and so does the
// JSON import that carries the package manifest.
const relativeTypeScriptSpecifier =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.[^"']*)\.ts\2/g;

export function rewriteSpecifiers(source: string): string {
  return source.replace(
    relativeTypeScriptSpecifier,
    (_match, lead, quote, path) => `${lead}${quote}${path}.js${quote}`,
  );
}
