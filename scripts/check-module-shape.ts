// Bun has no path manipulation API.
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import packageJson from "../package.json" with { type: "json" };

const root = process.cwd();
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

function isExportedStatement(node: ts.Statement): boolean {
  if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
    return true;
  }

  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function moduleName(path: string): string | undefined {
  const match = /^modules\/([^/]+)\//.exec(normalized(path));
  return match?.[1];
}

function isAllowedOutsideModules(path: string): boolean {
  return (
    path === "cli.ts" ||
    path.startsWith("scripts/") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".config.ts")
  );
}

function projectTarget(importer: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    const target = relative(root, resolve(dirname(resolve(root, importer)), specifier));
    return target.endsWith(".ts") ? target : `${target}.ts`;
  }

  const packagePrefix = `${packageJson.name}/`;
  if (specifier.startsWith(packagePrefix)) {
    return specifier.slice(packagePrefix.length);
  }

  return undefined;
}

function checkModuleInterface(path: string, sourceFile: ts.SourceFile): void {
  const exports = sourceFile.statements.filter(isExportedStatement);
  const exported = exports[0];

  if (exports.length !== 1 || !exported || !ts.isVariableStatement(exported)) {
    errors.push(`${path}: main.ts must export exactly one variable statement`);
    return;
  }

  const declarations = exported.declarationList.declarations;
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !/^[A-Z][A-Za-z0-9]*$/.test(declaration.name.text) ||
    !declaration.initializer ||
    !ts.isObjectLiteralExpression(declaration.initializer) ||
    declaration.initializer.properties.length === 0 ||
    !declaration.initializer.properties.every(ts.isMethodDeclaration)
  ) {
    errors.push(
      `${path}: main.ts must export one named PascalCase object whose properties are action methods`,
    );
  }
}

function checkImport(importer: string, specifier: ts.Expression): void {
  if (!ts.isStringLiteral(specifier)) {
    return;
  }

  const target = projectTarget(importer, specifier.text);
  if (!target) {
    return;
  }

  const targetModule = moduleName(target);
  if (!targetModule || moduleName(importer) === targetModule) {
    return;
  }

  const publicInterface = `modules/${targetModule}/main.ts`;
  if (normalized(target) !== publicInterface) {
    errors.push(`${importer}: imports private module file ${target}; import ${publicInterface}`);
  }
}

function checkImports(path: string, sourceFile: ts.SourceFile): void {
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      checkImport(path, node.moduleSpecifier);
    }

    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0]
    ) {
      checkImport(path, node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const moduleDirectories = new Set<string>();
for (const path of sourcePaths) {
  const normalizedPath = normalized(path);
  const name = moduleName(path);
  if (name) {
    moduleDirectories.add(name);
  }

  if (normalizedPath.startsWith("modules/") && !name) {
    errors.push(`${path}: production files must be inside a feature module`);
  }

  if (!normalizedPath.startsWith("modules/") && !isAllowedOutsideModules(normalizedPath)) {
    errors.push(`${path}: production TypeScript must live in modules/<feature>/`);
  }

  const text = await Bun.file(resolve(root, path)).text();
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  checkImports(path, sourceFile);

  if (/^modules\/[^/]+\/main\.ts$/.test(normalizedPath)) {
    checkModuleInterface(path, sourceFile);
  }
}

for (const directory of moduleDirectories) {
  const mainPath = `modules/${directory}/main.ts`;
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
