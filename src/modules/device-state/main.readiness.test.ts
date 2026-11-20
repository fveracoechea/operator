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

test.each([null, "historical-head"])(
  "the public stored codec preserves migration origin and head %s",
  (head) => {
    const receipt = {
      origin: "migration-0026" as const,
      head,
      at: "then",
      note: null,
      dispositions: [],
    };
    expect(DeviceState.storedPrReadinessSchema().parse(JSON.stringify(receipt))).toEqual(receipt);
    expect(DeviceState.prReadinessSchema().shape.dispositions.parse([])).toEqual([]);
  },
);
