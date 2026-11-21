import { expect, test } from "bun:test";
import { recoveryArgs } from "./internal-review-recovery-args.ts";

const flags = [
  "--source",
  "s",
  "--assignment",
  "a",
  "--launch",
  "l",
  "--pr",
  "415",
  "--head",
  "a".repeat(40),
];
test("recovery requires exact provenance and parses the authorization attestation", () => {
  expect(recoveryArgs(flags)).toEqual({
    operation: "internal_review_recover",
    sourceId: "s",
    assignment: "a",
    launchId: "l",
    number: 415,
    head: "a".repeat(40),
    personInstructed: false,
  });
  expect(recoveryArgs([...flags, "--person-instructed", "--json"])).toMatchObject({
    personInstructed: true,
  });
  for (let index = 0; index < flags.length; index += 2) {
    expect(
      recoveryArgs(flags.filter((_, position) => position !== index && position !== index + 1)),
    ).toBeNull();
  }
});

test("recovery rejects duplicate, absent, unknown and invalid values", () => {
  for (const tail of [
    ["--json", "--json"],
    ["--source", "x"],
    ["--person-instructed", "--person-instructed"],
    ["--unknown"],
    ["--launch"],
    ["--launch", "--json"],
  ])
    expect(recoveryArgs([...flags, ...tail])).toBeNull();
  for (const number of ["0", "-1", "1x", "9007199254740992"])
    expect(recoveryArgs(flags.map((value) => (value === "415" ? number : value)))).toBeNull();
  for (const head of ["a".repeat(39), "a".repeat(41), "g".repeat(40)])
    expect(
      recoveryArgs(flags.map((value) => (value === "a".repeat(40) ? head : value))),
    ).toBeNull();
  expect(recoveryArgs([])).toBeNull();
});

test("recovery accepts the first PR number", () => {
  expect(recoveryArgs(flags.with(7, "1"))).toEqual({
    operation: "internal_review_recover",
    sourceId: "s",
    assignment: "a",
    launchId: "l",
    number: 1,
    head: "a".repeat(40),
    personInstructed: false,
  });
});

test("recovery refuses an unknown flag even when it has a value", () => {
  expect(recoveryArgs([...flags, "--unknown", "value"])).toBeNull();
});

test.each(["--source", "--assignment", "--launch", "--pr", "--head"])(
  "recovery refuses a missing value for %s without throwing",
  (flag) => {
    const otherFlags = flags.toSpliced(flags.indexOf(flag), 2);
    expect(recoveryArgs([...otherFlags, flag])).toBeNull();
    expect(recoveryArgs([...otherFlags, flag, "--json"])).toBeNull();
  },
);

test("recovery treats a double-hyphen prefix as a flag, not a provenance value", () => {
  expect(recoveryArgs(flags.with(1, "--unexpected"))).toBeNull();
  expect(recoveryArgs(flags.with(1, "source--"))).toMatchObject({ sourceId: "source--" });
});

test.each([
  "",
  "A".repeat(40),
  "a".repeat(39),
  "a".repeat(41),
  "g".repeat(40),
  ` ${"a".repeat(40)}`,
])("recovery rejects the invalid authorized head %j", (head) => {
  expect(recoveryArgs(flags.with(9, head))).toBeNull();
});

test("recovery preserves every character of an authorized hexadecimal head", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  expect(recoveryArgs(flags.with(9, head))).toEqual({
    operation: "internal_review_recover",
    sourceId: "s",
    assignment: "a",
    launchId: "l",
    number: 415,
    head,
    personInstructed: false,
  });
});
