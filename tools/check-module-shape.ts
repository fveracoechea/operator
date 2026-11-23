// Bun has no path manipulation API.
import path from "node:path";

const root = process.cwd();
const { sep } = path;
const errors: string[] = [];
const sourcePaths = [
  ...new Set(
    (
      await Promise.all(
        ["*.ts", "**/*.ts"].map((pattern) =>
          Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })),
        ),
      )
    ).flat(),
  ),
].filter(
  (path) =>
    !path.startsWith("node_modules/") &&
    !path.startsWith(".agents/") &&
    !path.startsWith(".claude/"),
);

function normalized(path: string): string {
  return path.split(sep).join("/");
}

function moduleName(path: string): string | undefined {
  const match = /^src\/modules\/([^/]+)\//.exec(normalized(path));
  return match?.[1];
}

function isAllowedOutsideModules(path: string): boolean {
  return (
    path === "src/cli.ts" ||
    path.startsWith("src/lib/") ||
    path.startsWith("tools/") ||
    path.startsWith("packages/") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".config.ts")
  );
}

const moduleDirectories = new Set<string>();
for (const path of sourcePaths) {
  const normalizedPath = normalized(path);
  const name = moduleName(path);
  if (name) {
    moduleDirectories.add(name);
  }

  if (normalizedPath.startsWith("src/modules/") && !name) {
    errors.push(`${path}: production files must be inside a feature module`);
  }

  if (!normalizedPath.startsWith("src/modules/") && !isAllowedOutsideModules(normalizedPath)) {
    errors.push(`${path}: production TypeScript must live in src/modules/<feature>/ or src/lib/`);
  }
}

for (const directory of moduleDirectories) {
  const mainPath = `src/modules/${directory}/main.ts`;
  if (!sourcePaths.includes(mainPath)) {
    errors.push(`${mainPath}: every module requires one public interface`);
  }
}

if (errors.length > 0) {
  for (const error of errors.toSorted()) {
    console.error(error);
  }
  process.exitCode = 1;
}
