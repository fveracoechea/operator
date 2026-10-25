import { expect, test } from "bun:test";
import { suppressionErrors, excludedUnit } from "./mutation-policy.ts";

test("only the approved whole-file no-logic marker and explained local suppressions pass", () => {
  expect(suppressionErrors("// Stryker disable all: no logic\nexport type A = string;\n")).toEqual(
    [],
  );
  expect(
    suppressionErrors(
      "// Stryker disable next-line ArithmeticOperator: equivalent: integer inputs cannot differ\nconst n = 1;\n",
    ),
  ).toEqual([]);
  expect(
    suppressionErrors(
      "/* Stryker disable next-line StringLiteral: no rule: diagnostic text is not a contract */\nconst message = 'ok';\n",
    ),
  ).toEqual([]);
  for (const reason of ["", "equivalent:", "no rule:", "hard to test", "no logic"]) {
    expect(
      suppressionErrors(
        `const n = 1;\n// Stryker disable next-line ArithmeticOperator: ${reason}\n`,
      ),
    ).toEqual([2]);
  }
  expect(suppressionErrors("// Stryker disable all: equivalent: not a local exemption\n")).toEqual([
    1,
  ]);
  expect(
    suppressionErrors(
      "// Stryker disable next-line StringLiteral, all: equivalent: not a named exemption\n",
    ),
  ).toEqual([1]);
});

test("text in strings is not a suppression, and multiline comments retain line numbers", () => {
  expect(suppressionErrors('const text = "// Stryker disable all";\n')).toEqual([]);
  expect(
    suppressionErrors("/*\n * Stryker disable next-line StringLiteral: bad\n */\nconst x = '';\n"),
  ).toEqual([2]);
  expect(
    suppressionErrors(
      `const text = \`value \${1}\n// Stryker disable all: example text\n\`;\n// Stryker disable all: invalid\n`,
    ),
  ).toEqual([4]);
  expect(
    suppressionErrors(
      'const pattern = /[\\/\\/]Stryker disable all/;\n// Stryker disable next-line StringLiteral: invalid\nconst x = "";\n',
    ),
  ).toEqual([2]);
});

test("test, fixture, declaration, and generated paths are not units", () => {
  for (const name of [
    "lib/a.test.ts",
    "lib/a.spec.ts",
    "lib/a-fixture.ts",
    "lib/fixtures/a.ts",
    "lib/generated/a.ts",
    "lib/a.generated.ts",
    "lib/a.d.ts",
    "README.md",
  ]) {
    expect(excludedUnit(name)).toBe(true);
  }
  for (const name of [
    "modules/a/main.ts",
    "modules/a/private.ts",
    "lib/sha256.ts",
    "scripts/release.ts",
    "tools/oxlint/rule.ts",
  ]) {
    expect(excludedUnit(name)).toBe(false);
  }
});
