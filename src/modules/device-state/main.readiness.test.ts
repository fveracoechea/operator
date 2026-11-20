import { expect, test } from "bun:test";
import { DeviceState } from "./main.ts";

test("the shared public storage decoder retains ready evidence and refuses a malformed receipt", () => {
  const decoder = DeviceState.storedPrReadinessSchema();
  expect(decoder.parse(null)).toBeNull();
  expect(
    decoder.parse(
      JSON.stringify({
        head: "pushed",
        at: "now",
        note: "/device/note.md",
        dispositions: [{ round: 1, finding: 2, disposition: "applied" }],
      }),
    ),
  ).toEqual({
    head: "pushed",
    at: "now",
    note: "/device/note.md",
    dispositions: [{ round: 1, finding: 2, disposition: "applied" }],
  });
  expect(() => decoder.parse("{}")).toThrow();
});
