import { expect, test } from "bun:test";
import path from "node:path";
import { ruleProbe } from "../rule-probe-fixture.ts";

const probe = ruleProbe();
const imports = `import { arrayMethodTarget } from ${JSON.stringify(path.join(import.meta.dir, "array-method.ts"))};`;

test("reads static and string-literal method names, and only those", async () => {
  const found = await probe({
    imports,
    visitor:
      "{ CallExpression(node) { report(node, arrayMethodTarget(node.callee)?.name ?? null); } }",
    code: [
      "items.map(f);",
      'items["filter"](f);',
      "items[0](f);",
      "items[name](f);",
      "(items as string[]).slice();",
      "run();",
    ].join("\n"),
  });

  expect(found).toEqual(['1 "map"', '2 "filter"', "3 null", "4 null", '5 "slice"', "6 null"]);
});
