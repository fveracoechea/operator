// Bun has no path manipulation API.
import { relative, resolve, sep } from "node:path";

const skillsRoot = resolve(process.cwd(), process.argv[2] ?? "skills");
const errors: string[] = [];

// opencode drops every field outside this set without a word.
const portableFloor = new Set(["name", "description", "license", "compatibility", "metadata"]);
const routerLineLimit = 150;

function normalized(path: string): string {
  return path.split(sep).join("/");
}

function countLines(text: string): number {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function frontmatter(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("---\n")) {
    return undefined;
  }

  const end = text.indexOf("\n---\n", 3);
  if (end === -1) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text.slice(4, end + 1));
  } catch {
    return undefined;
  }

  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function linkedFiles(skillDirectory: string, text: string): Set<string> {
  const linked = new Set<string>();
  for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (!target) {
      continue;
    }

    const path = target.split("#")[0];
    if (!path?.endsWith(".md") || URL.canParse(path)) {
      continue;
    }

    linked.add(normalized(relative(skillDirectory, resolve(skillDirectory, path))));
  }

  return linked;
}

function checkFrontmatter(routerPath: string, directory: string, text: string): void {
  const fields = frontmatter(text);
  if (!fields) {
    errors.push(`${routerPath}: requires a readable frontmatter block delimited by ---`);
    return;
  }

  if (fields["name"] !== directory) {
    errors.push(
      `${routerPath}: frontmatter name ${JSON.stringify(fields["name"])} must be the directory name "${directory}"`,
    );
  }

  for (const field of Object.keys(fields)) {
    if (!portableFloor.has(field)) {
      errors.push(`${routerPath}: frontmatter field "${field}" is outside the portable floor`);
    }
  }
}

async function checkTopicFiles(directory: string, text: string): Promise<void> {
  const skillDirectory = resolve(skillsRoot, directory);
  const linked = linkedFiles(skillDirectory, text);

  for await (const path of new Bun.Glob("**/*.md").scan({ cwd: skillDirectory, onlyFiles: true })) {
    if (path === "SKILL.md" || linked.has(path)) {
      continue;
    }

    errors.push(
      `${normalized(relative(process.cwd(), resolve(skillDirectory, path)))}: no link in SKILL.md reaches this file`,
    );
  }
}

for await (const routerPath of new Bun.Glob("*/SKILL.md").scan({
  cwd: skillsRoot,
  onlyFiles: true,
})) {
  const directory = normalized(routerPath).split("/")[0] ?? "";
  const reportedPath = normalized(relative(process.cwd(), resolve(skillsRoot, routerPath)));
  const text = await Bun.file(resolve(skillsRoot, routerPath)).text();

  checkFrontmatter(reportedPath, directory, text);

  const lines = countLines(text);
  if (lines > routerLineLimit) {
    errors.push(
      `${reportedPath}: a router is ${routerLineLimit} lines at most, and this is ${lines}`,
    );
  }

  await checkTopicFiles(directory, text);
}

if (errors.length > 0) {
  for (const error of errors.toSorted()) {
    console.error(error);
  }
  process.exitCode = 1;
}
