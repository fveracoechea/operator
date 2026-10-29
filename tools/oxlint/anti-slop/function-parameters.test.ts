import { expect, test } from "bun:test";
import path from "node:path";
import { ruleProbe } from "../rule-probe-fixture.ts";

const probe = ruleProbe();
const imports = `import { containsUnknownType, parameterBindingName, parameterOwnerVisitor, parameterTypeAnnotation } from ${JSON.stringify(path.join(import.meta.dir, "function-parameters.ts"))};`;

test("visits every function and signature that declares parameters", async () => {
  const found = await probe({
    imports,
    visitor: "parameterOwnerVisitor((node) => report(node, node.type))",
    code: [
      "const arrow = (a: string) => a;",
      "function declared(a: string) { return a; }",
      "const expression = function (a: string) { return a; };",
      "type Call = { (a: string): void };",
      "type Construct = { new (a: string): object };",
      "type Constructor = new (a: string) => object;",
      "declare function ambient(a: string): void;",
      "abstract class Shape { abstract area(a: string): number; }",
      "type Callback = (a: string) => void;",
      "type Method = { run(a: string): void };",
    ].join("\n"),
  });

  expect(found).toEqual([
    '1 "ArrowFunctionExpression"',
    '2 "FunctionDeclaration"',
    '3 "FunctionExpression"',
    '4 "TSCallSignatureDeclaration"',
    '5 "TSConstructSignatureDeclaration"',
    '6 "TSConstructorType"',
    '7 "TSDeclareFunction"',
    '8 "TSEmptyBodyFunctionExpression"',
    '9 "TSFunctionType"',
    '10 "TSMethodSignature"',
  ]);
});

test("finds unknown alone, in parentheses, and in a union, but not inside other types", async () => {
  const found = await probe({
    imports,
    visitor:
      "{ TSTypeAliasDeclaration(node) { report(node, containsUnknownType(node.typeAnnotation)); } }",
    code: [
      "type A = unknown;",
      "type B = (unknown);",
      "type C = string | unknown;",
      "type D = string | (number | (unknown));",
      "type E = string | number;",
      "type F = (string);",
      "type G = string & unknown;",
      "type H = Array<unknown>;",
    ].join("\n"),
  });

  expect(found).toEqual([
    "1 true",
    "2 true",
    "3 true",
    "4 true",
    "5 false",
    "6 false",
    "7 false",
    "8 false",
  ]);
});

test("reads the annotation and the binding text through every parameter wrapper", async () => {
  const found = await probe({
    imports,
    visitor: `parameterOwnerVisitor((node) => {
      for (const parameter of node.params) {
        const annotation = parameterTypeAnnotation(parameter);
        report(parameter, [
          parameterBindingName(parameter, context.sourceCode),
          annotation ? context.sourceCode.getText(annotation.typeAnnotation) : null,
        ]);
      }
    })`,
    code: [
      "function plain(name: string) {}",
      "function bare(name) {}",
      "function rest(...items: number[]) {}",
      "function fallback(count: number = 1) {}",
      "function untypedFallback(count = 1) {}",
      "function shape({ a, b }  : Options) {}",
      "function list([first, second]) {}",
      "function spreadShape(...[head]: string[]) {}",
      "function defaultShape({ a }: Options = {}) {}",
      "class Account { constructor(private readonly owner: string) {} }",
      "class Ledger { constructor(public total = 0) {} }",
    ].join("\n"),
  });

  expect(found).toEqual([
    '1 ["name","string"]',
    '2 ["name",null]',
    '3 ["items","number[]"]',
    '4 ["count","number"]',
    '5 ["count",null]',
    '6 ["{ a, b }","Options"]',
    '7 ["[first, second]",null]',
    '8 ["[head]","string[]"]',
    '9 ["{ a }","Options"]',
    '10 ["owner","string"]',
    '11 ["total",null]',
  ]);
});
