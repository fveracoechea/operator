import { expect, test } from "bun:test";
import path from "node:path";
import { ruleProbe } from "../rule-probe-fixture.ts";

const probe = ruleProbe();

// Each `Check` alias reports whether its type holds unknown after local aliases resolve.
const visitor = `{
  TSTypeAliasDeclaration(node) {
    if (!node.id.name.startsWith("Check")) return;
    const holdsUnknown = (type, matches) =>
      type.type === "TSUnknownKeyword" ||
      (type.type === "TSUnionType" && type.types.some(matches)) ||
      (type.type === "TSArrayType" && matches(type.elementType));
    report(node, [node.id.name, resolvedTypeMatches(context.sourceCode, node.typeAnnotation, holdsUnknown)]);
  },
}`;

async function resolve(code: string[]): Promise<string[]> {
  const found = await probe({
    imports: `import { resolvedTypeMatches } from ${JSON.stringify(path.join(import.meta.dir, "type-alias-resolution.ts"))};`,
    visitor,
    code: code.join("\n"),
  });
  return found.map((line) => line.slice(line.indexOf(" ") + 1));
}

test("resolves local aliases and their explicit type arguments", async () => {
  expect(
    await resolve([
      "type Hidden = unknown;",
      "type Box<T> = T[];",
      "type Wrap<T> = Box<T>;",
      "type CheckAlias = Hidden;",
      "type CheckArgument = Box<unknown>;",
      "type CheckString = Box<string>;",
      "type CheckNested = Wrap<unknown>;",
      "type CheckNestedString = Wrap<string>;",
      "type CheckDirect = string | unknown;",
      "type CheckPlain = string;",
    ]),
  ).toEqual([
    '["CheckAlias",true]',
    '["CheckArgument",true]',
    '["CheckString",false]',
    '["CheckNested",true]',
    '["CheckNestedString",false]',
    '["CheckDirect",true]',
    '["CheckPlain",false]',
  ]);
});

test("uses defaults, which can name earlier parameters, and stops at a missing argument", async () => {
  expect(
    await resolve([
      "type Maybe<T = unknown> = T | null;",
      "type Second<A, B = A> = B;",
      "type Needed<T> = T;",
      "type CheckDefault = Maybe;",
      "type CheckOverride = Maybe<string>;",
      "type CheckEarlier = Second<unknown>;",
      "type CheckEarlierString = Second<string>;",
      "type CheckMissing = Needed;",
    ]),
  ).toEqual([
    '["CheckDefault",true]',
    '["CheckOverride",false]',
    '["CheckEarlier",true]',
    '["CheckEarlierString",false]',
    '["CheckMissing",false]',
  ]);
});

test("lets a type parameter shadow an alias and stops on a recursive alias", async () => {
  expect(
    await resolve([
      "type Hidden = unknown;",
      "type Tree = Tree[] | string;",
      "type CheckShadow<Hidden> = Hidden[];",
      "type CheckTree = Tree;",
      "type CheckQualified = Space.Hidden;",
      "type CheckUndeclared = Missing;",
      "const Twin = 1;",
      "type Twin = unknown;",
      "type CheckTwin = Twin;",
    ]),
  ).toEqual([
    '["CheckShadow",false]',
    '["CheckTree",false]',
    '["CheckQualified",false]',
    '["CheckUndeclared",false]',
    '["CheckTwin",true]',
  ]);
});
