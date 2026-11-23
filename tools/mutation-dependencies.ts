// Bun has no directory metadata or real-path API.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import {
  traverseFast,
  isCallExpression,
  isIdentifier,
  isImportSpecifier,
  isMemberExpression,
  isImportDeclaration,
  isExportNamedDeclaration,
  isExportAllDeclaration,
  isStringLiteral,
  matchesPattern,
  type Node,
} from "@babel/types";
import { z } from "zod";
import type { MutationUnit } from "./mutation-selection.ts";

type Dependencies = { imports: string[]; fixtures: string[]; uncertain: boolean };

function inspectImport(node: Node, result: Dependencies): void {
  if (
    // Stryker disable next-line ConditionalExpression: equivalent: other AST nodes have no source string, and the next source guard discards them
    !isImportDeclaration(node) &&
    !isExportNamedDeclaration(node) &&
    !isExportAllDeclaration(node)
  )
    return;
  if (node.source) result.imports.push(node.source.value);
  if (!node.source || !["fs", "node:fs"].includes(node.source.value)) return;
  // Stryker disable next-line ConditionalExpression, BlockStatement: equivalent: export specifiers cannot be allowed fs imports, and an export-all without specifiers is rejected by the enclosing identity boundary
  if (node.type !== "ImportDeclaration") {
    result.uncertain = true;
    return;
  }
  result.uncertain ||= node.specifiers.some(
    (specifier) =>
      !(
        isImportSpecifier(specifier) && isIdentifier(specifier.imported, { name: "appendFileSync" })
      ),
  );
}

function inspectFileRead(node: Node, result: Dependencies, allowed: Set<Node>): void {
  if (!isCallExpression(node) || !isMemberExpression(node.callee)) return;
  const callee = node.callee;
  if (matchesPattern(callee, "Bun.write")) {
    allowed.add(callee.object);
    return;
  }
  if (!matchesPattern(callee, "Bun.file")) return;
  allowed.add(callee.object);
  const argument = node.arguments[0];
  if (isStringLiteral(argument) && !path.isAbsolute(argument.value))
    result.fixtures.push(argument.value);
  else result.uncertain = true;
}

function inspectEngineProcess(node: Node, allowed: Set<Node>): void {
  // Stryker disable next-line ConditionalExpression: equivalent: matchesPattern only matches member expressions, so other nodes add no allowed process reference
  if (!isMemberExpression(node)) return;
  if (matchesPattern(node, "process.pid")) allowed.add(node.object);
  if (
    matchesPattern(node, "process.env.__STRYKER_ACTIVE_MUTANT__") &&
    isMemberExpression(node.object)
  )
    allowed.add(node.object.object);
}

function dependencies(source: string): Dependencies {
  const result: Dependencies = { imports: [], fixtures: [], uncertain: false };
  const ast = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
  const allowed = new Set<Node>();
  traverseFast(ast, (node) => {
    inspectImport(node, result);
    inspectFileRead(node, result, allowed);
    inspectEngineProcess(node, allowed);
    if (node.type === "ImportExpression") result.uncertain = true;
  });
  traverseFast(ast, (node) => {
    if (node.type !== "Identifier") return;
    if (
      [
        "process",
        "globalThis",
        "global",
        "eval",
        "Function",
        "require",
        "fetch",
        "URL",
        "WebSocket",
        "Date",
      ].includes(node.name) &&
      !allowed.has(node)
    )
      result.uncertain = true;
    if (node.name === "Bun" && !allowed.has(node)) result.uncertain = true;
  });
  return result;
}

export type MutationIdentity =
  | { eligible: true; identity: string }
  | {
      eligible: false;
      reason: "unsupported-test-command" | "uncertain-inputs" | "unreadable-inputs";
    };

export async function mutationUnitIdentity(
  root: string,
  unit: MutationUnit,
  toolchain: string,
): Promise<MutationIdentity> {
  const inputs = new Map<string, string>();
  let uncertain = false;
  async function visit(file: string): Promise<void> {
    const name = path.relative(root, file);
    if (name.startsWith("..") || path.isAbsolute(name)) {
      uncertain = true;
      return;
    }
    if (inputs.has(name)) return;
    const contents = await Bun.file(file).text();
    const bytes = await Bun.file(file).bytes();
    const stat = await lstat(file);
    if (!stat.isFile()) {
      uncertain = true;
      return;
    }
    inputs.set(name, `${stat.mode}:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const snapshot = path.join(path.dirname(file), "__snapshots__", `${path.basename(file)}.snap`);
    if (await Bun.file(snapshot).exists()) await visit(snapshot);
    const graph = dependencies(contents);
    uncertain ||= graph.uncertain;
    for (const fixture of graph.fixtures) await visit(path.resolve(root, fixture));
    for (const imported of graph.imports) {
      if (["bun:test", "node:fs", "fs"].includes(imported)) continue;
      if (!imported.startsWith(".")) {
        uncertain = true;
        continue;
      }
      try {
        await visit(Bun.resolveSync(imported, path.dirname(file)));
      } catch {
        uncertain = true;
      }
    }
  }

  try {
    const command = z
      .object({ scripts: z.object({ test: z.string() }) })
      .parse(await Bun.file(path.join(root, "package.json")).json());
    if (!["bun test", "bun test --isolate"].includes(command.scripts.test))
      return { eligible: false, reason: "unsupported-test-command" };
    for (const name of [unit.name, ...unit.tests]) await visit(path.resolve(root, name));
    for await (const name of new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true })) {
      if (name.split("/").some((part) => part === "node_modules" || part.startsWith(".mutation-")))
        continue;
      if (/\.(?:json|toml|ya?ml|lock|lockb)$/.test(name) || path.basename(name).startsWith(".env"))
        inputs.set(
          name,
          JSON.stringify([
            (await lstat(path.join(root, name))).mode,
            new Bun.CryptoHasher("sha256")
              .update(await Bun.file(path.join(root, name)).bytes())
              .digest("hex"),
          ]),
        );
      if (
        path.basename(name) === "bunfig.toml" &&
        /\bpreload\b/.test(await Bun.file(path.join(root, name)).text())
      )
        uncertain = true;
    }
    const runner = path.join(root, "tools/test-watchdog.ts");
    if (await Bun.file(runner).exists()) await visit(runner);
  } catch {
    return { eligible: false, reason: "unreadable-inputs" };
  }
  if (uncertain) return { eligible: false, reason: "uncertain-inputs" };
  const identity = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        1,
        toolchain,
        unit.name,
        unit.patterns,
        unit.tests,
        [...inputs].map((entry) => JSON.stringify(entry)).toSorted(),
      ]),
    )
    .digest("hex");
  return { eligible: true, identity };
}
