import { expect, test } from "bun:test";
import { WorkSources } from "./main.ts";

test("workflow refusal recovery preserves the guard's checked facts and authority", () => {
  const owner = {
    next: { decider: "person" as const, question: "May retained work be removed?" },
    state: { changed: true },
  };
  expect(WorkSources.refusal("cleanup", "cleanup_unlanded_work", owner)).toBe(owner);
  expect(WorkSources.refusal("report_submit", "report_returned", {})).toEqual({
    next: {
      command: "operator report resume",
      why: "Read the returned report's follow-up before submitting again.",
    },
  });
});
