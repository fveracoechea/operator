// The write-path grammar of ADR 0018. It is the one rule for what "inside" means, so every check
// that compares write paths reads them through this matcher.

const globCharacters = /[*?[\]{}]/;

/** Why a write path is not in its one canonical form, or null when it is. */
export function writePathRefusal(path: string): string | null {
  if (path.startsWith("/")) {
    return "a write path is named from the repository root, so it cannot be absolute";
  }
  if (path.includes("\\")) {
    return "a write path separates its segments with /, never with a backslash";
  }
  if (globCharacters.test(path)) {
    return "a write path names a file or a folder, never a glob";
  }
  if (segmentsOf(path).some((one) => one === "" || one === "." || one === "..")) {
    return "a write path has no empty, . or .. segment";
  }
  return null;
}

/**
 * The canonical form of a write path that an earlier release stored with no grammar, or why it
 * has none. It reads only the text: an empty or "." segment goes, and ".." takes out the segment
 * before it. A path that ends in "." or ".." names a folder. A stored path with no final "/" stays
 * a file, because the grammar names a folder only by its final "/".
 */
export function canonicalWritePath(path: string): { canonical: string } | { refusal: string } {
  const refusal = writePathRefusal(path);
  if (refusal === null) {
    return { canonical: path };
  }
  const named = `the stored write path "${path}"`;
  if (path.startsWith("/") || path.includes("\\") || globCharacters.test(path)) {
    return { refusal: `${named} has no canonical form: ${refusal}` };
  }

  const parts = path.split("/");
  const segments: string[] = [];
  for (const part of parts) {
    if (part === ".." && segments.pop() === undefined) {
      return { refusal: `${named} leaves the repository root` };
    }
    if (part !== "" && part !== "." && part !== "..") {
      segments.push(part);
    }
  }
  if (segments.length === 0) {
    return { refusal: `${named} names no file or folder inside the repository` };
  }
  const last = parts.at(-1);
  const folder = last === "" || last === "." || last === "..";
  return { canonical: `${segments.join("/")}${folder ? "/" : ""}` };
}

/** A folder path ends with `/`, so its last segment is the folder itself. */
function segmentsOf(path: string): string[] {
  return (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
}

/** A folder covers a path when its segments are a prefix of the path's segments. */
function covers(path: string, other: string): boolean {
  if (path === other) {
    return true;
  }
  if (!path.endsWith("/")) {
    return false;
  }
  const folder = segmentsOf(path);
  const inside = segmentsOf(other);
  return folder.length <= inside.length && folder.every((one, index) => one === inside[index]);
}

/** Each pair of paths, one from each list, where one covers the other, in list order. */
export function overlappingPaths(paths: string[], others: string[]): Array<[string, string]> {
  return paths.flatMap((path) =>
    others
      .filter((other) => covers(path, other) || covers(other, path))
      .map((other): [string, string] => [path, other]),
  );
}

/** The one command that lists each overlapping pair of one source, for every report that counts them. */
export function overlapsCommand(sourceId: string): string {
  return `operator work overlaps --source ${sourceId}`;
}
