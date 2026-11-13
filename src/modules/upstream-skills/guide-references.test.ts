import { expect, test } from "bun:test";
import { guideReferences } from "./guide-references.ts";

test("guide fixtures name required skills and relative skill links, not CLI examples", () => {
  expect(
    guideReferences(
      [
        "Load `tdd` and `pr` for the change.",
        "Load `diagnosing-bugs` when a reproduction fails.",
        "Read [handoff](../../handoff/SKILL.md).",
        "Read `../../show-me/SKILL.md` for a visual explanation.",
        "Use `operator pr associate --json` and `internal-review.md`.",
        "Load `tdd` again after compaction.",
      ].join("\n"),
    ),
  ).toEqual([
    { name: "tdd", link: null },
    { name: "pr", link: null },
    { name: "diagnosing-bugs", link: null },
    { name: "handoff", link: "../../handoff/SKILL.md" },
    { name: "show-me", link: "../../show-me/SKILL.md" },
  ]);
  expect(guideReferences("No skill references.")).toEqual([]);
});
