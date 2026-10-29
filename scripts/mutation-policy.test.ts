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
  for (const name of ["ALL", "All", "StringLiteral, AlL"]) {
    expect(
      suppressionErrors(`// Stryker disable next-line ${name}: no rule: blanket skip\n`),
    ).toEqual([1]);
  }
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

test("a suppression comment is found by its own leading text, spacing, and comment style", () => {
  const cases: [string, number[]][] = [
    ["//Stryker disable all\n", [1]],
    ["// Stryker  disable all\n", [1]],
    ["/**Stryker disable all */\n", [1]],
    ["/** Stryker disable all */\n", [1]],
    ["// note: Stryker disable all is not a suppression here\n", []],
    ["const a = 1;\n// Stryker disable all: no logic\n", [2]],
    ["/* Stryker disable all: no logic*/\nconst a = 1;\n", [1]],
    ["// Stryker disable all and Stryker disable next-line A: no rule: why\n", [1]],
    ["//Stryker disable next-line StringLiteral: no rule: why\n", []],
    ["/**Stryker disable next-line StringLiteral: no rule: why */\n", []],
    ["/*\n * Stryker disable next-line StringLiteral: no rule: why\n */\n", []],
    ["// Stryker disable next-line StringLiteral: no rule:   \n", [1]],
    ["// Stryker disable next-line StringLiteral: equivalent:why\n", []],
  ];
  for (const [source, lines] of cases) {
    expect(suppressionErrors(source), source).toEqual(lines);
  }
});

test("an explained suppression may name several mutators with any comma spacing", () => {
  for (const names of [
    "StringLiteral,Regex",
    "StringLiteral , Regex",
    "StringLiteral, Regex",
    "StringLiteral,\tRegex , ArrayDeclaration",
  ]) {
    expect(
      suppressionErrors(`// Stryker disable next-line ${names}: no rule: why\n`),
      names,
    ).toEqual([]);
  }
  expect(suppressionErrors("// Stryker disable next-line StringLiteral,: no rule: why\n")).toEqual([
    1,
  ]);
  expect(
    suppressionErrors("// Stryker disable next-line StringLiteral, 1x: no rule: why\n"),
  ).toEqual([1]);
});

test("folders count as excluded only as whole folder names, and a test name must end the path", () => {
  for (const name of [
    "fixtures/a.ts",
    "lib/fixture/a.ts",
    "generated/a.ts",
    "lib/__tests__/a.ts",
  ]) {
    expect(excludedUnit(name), name).toBe(true);
  }
  for (const name of [
    "lib/a.test.tsx.ts",
    "lib/a.d.tsx.ts",
    "lib/myfixtures/a.ts",
    "lib/generated.ts",
    "lib/fixtures.ts",
  ]) {
    expect(excludedUnit(name), name).toBe(false);
  }
});
