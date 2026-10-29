import { expect, test } from "bun:test";
import path from "node:path";
import { ruleProbe } from "../rule-probe-fixture.ts";

const probe = ruleProbe();

test("matches only the named method on the global Reflect", async () => {
  const found = await probe({
    imports: `import { isGlobalReflectMethod } from ${JSON.stringify(path.join(import.meta.dir, "reflect-method.ts"))};`,
    visitor:
      '{ CallExpression(node) { report(node, isGlobalReflectMethod(context.sourceCode, node.callee, "get")); } }',
    code: [
      "Reflect.get(item, key);",
      'Reflect["get"](item, key);',
      "Reflect.has(item, key);",
      "Store.get(item, key);",
      "globalThis.Reflect.get(item, key);",
      "get(item, key);",
      "function shadow(Reflect: { get(): number }) { return Reflect.get(); }",
      "{ const Reflect = { get: () => 1 }; Reflect.get(); }",
    ].join("\n"),
  });

  expect(found).toEqual([
    "1 true",
    "2 true",
    "3 false",
    "4 false",
    "5 false",
    "6 false",
    "7 false",
    "8 false",
  ]);
});
