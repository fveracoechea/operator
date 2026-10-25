import { expect, test } from "bun:test";
import { firstMatch } from "./first-match.ts";

test("first applicable rule wins and later rules do not run", () => {
  const visited: string[] = [];
  expect(
    firstMatch(
      [
        {
          name: "miss",
          decide() {
            visited.push("miss");
            return undefined;
          },
        },
        {
          name: "first",
          decide() {
            visited.push("first");
            return 0;
          },
        },
        {
          name: "later",
          decide() {
            visited.push("later");
            return 2;
          },
        },
      ],
      {},
      9,
    ),
  ).toBe(0);
  expect(visited).toEqual(["miss", "first"]);
});

test("no rule uses the supplied fallback, including an empty table", () => {
  expect(firstMatch([], {}, "refused")).toBe("refused");
  expect(
    firstMatch(
      [
        {
          name: "miss",
          decide() {
            return undefined;
          },
        },
      ],
      {},
      "refused",
    ),
  ).toBe("refused");
});
