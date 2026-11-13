import { expect, test } from "bun:test";
import type { Round } from "./request.ts";
import { replyText, roundEffects, startEffects } from "./slack-effects.ts";

const head = "a".repeat(40);
function round(change: Partial<Round> & { niceToHaves?: number }): Round {
  const { niceToHaves = 0, ...rest } = change;
  return {
    requestId: "r1",
    number: 1,
    trigger: "first",
    reviewedCommit: head,
    draft: JSON.stringify({
      reviewedCommit: head,
      summary: "One line.",
      niceToHaves: Array.from({ length: niceToHaves }, () => ({ detail: "Later." })),
    }),
    event: "COMMENT",
    body: "",
    marker: "",
    outcome: "posted",
    reviewId: "1",
    reviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-1",
    postedAt: "t",
    warning: null,
    blockers: "[]",
    ...rest,
  };
}
const link = "[review](https://github.com/o/r/pull/7#pullrequestreview-1)";

test("a first round shows its status, nonzero counts, the link, and at most three blockers", () => {
  const first = round({
    blockers: JSON.stringify(["typecheck fails in `auth.ts`", "no test for\nthe guard", "c", "d"]),
    niceToHaves: 1,
  });
  expect(replyText([first], first, "u")).toBe(
    `Needs changes · 4 blockers, 1 nice to have · ${link}\n• typecheck fails in \`auth.ts\`\n• no test for the guard\n• c`,
  );
});

test.each([
  ["APPROVE", "[]", 0, `Approved · ${link}`],
  [
    "REQUEST_CHANGES",
    '["breaks the module boundary"]',
    0,
    `Changes requested · 1 blocker · ${link}\n• breaks the module boundary`,
  ],
  ["COMMENT", "[]", 2, `No blockers · 2 nice to haves · ${link}`],
])("a %s round with %s", (event, blockers, niceToHaves, text) => {
  const only = round({ event, blockers, niceToHaves });
  expect(replyText([only], only, "u")).toBe(text);
});

test("a later round says how many earlier blockers are gone and shows only open ones", () => {
  const first = round({ blockers: '["a","b"]' });
  const failed = round({ number: 2, outcome: "failed", blockers: '["x","y","z"]' });
  const second = round({ number: 3, blockers: '["b"]' });
  const third = round({ number: 4, event: "APPROVE", blockers: "[]" });
  const rounds = [first, failed, second, third];
  expect(replyText(rounds, second, "u")).toBe(
    `Needs changes · 1 blocker · 1 of 2 fixed · ${link}\n• b`,
  );
  expect(replyText(rounds, third, "u")).toBe(`Approved · 1 of 1 fixed · ${link}`);
  // More blockers than before count no fix. A first round with no blockers shows no progress.
  const more = round({ number: 2, blockers: '["a","b","c"]' });
  expect(replyText([first, more], more, "u")).toContain(" · 0 of 2 fixed · ");
  const clean = round({ event: "APPROVE" });
  const after = round({ number: 2, event: "APPROVE" });
  expect(replyText([clean, after], after, "u")).toBe(`Approved · ${link}`);
});

test("a blocker shows as one trimmed line, and an unknown event reads as a comment", () => {
  const spaced = round({ event: "DISMISSED", blockers: '["  a  \\n\\t b  "]' });
  expect(replyText([spaced], spaced, "u")).toBe(`Needs changes · 1 blocker · ${link}\n• a b`);
  expect(roundEffects([spaced], spaced, "u")[0]).toEqual({
    key: "reaction:speech_balloon",
    kind: "reaction",
    content: "speech_balloon",
  });
});

test("the reviewed-at suffix appears only at the head-move limit", () => {
  const limited = round({
    warning: JSON.stringify({ reviewedCommit: "1234567890abcdef", head: "f".repeat(40), moves: 3 }),
  });
  expect(replyText([limited], limited, "u")).toBe(`No blockers · ${link} · reviewed at 1234567`);
});

test("a round from before the blocker record uses its draft, and a missing URL uses the PR", () => {
  const old = round({
    blockers: null,
    reviewUrl: null,
    draft: JSON.stringify({
      reviewedCommit: head,
      summary: "One line.",
      blockers: [{ short: "Guard has no test", detail: "Add one." }],
    }),
  });
  expect(replyText([old], old, "https://github.com/o/r/pull/7")).toBe(
    "Needs changes · 1 blocker · [review](https://github.com/o/r/pull/7)\n• Guard has no test",
  );
});

test("a round that an earlier release stored gives its blockers and nice to haves", () => {
  const old = round({
    blockers: null,
    draft: JSON.stringify({
      reviewedCommit: head,
      summary: "One line.",
      blockers: [
        {
          short: "Guard has no test",
          detail: "Add one.",
          breach: { source: "opinions", rule: "Verify every guard." },
        },
      ],
      niceToHaves: [{ detail: "Later." }],
    }),
  });
  expect(replyText([old], old, "u")).toBe(
    `Needs changes · 1 blocker, 1 nice to have · ${link}\n• Guard has no test`,
  );
});

test("each round adds its outcome reaction and one reply, keyed so a retry adds nothing", () => {
  expect(startEffects()).toEqual([{ key: "reaction:eyes", kind: "reaction", content: "eyes" }]);
  for (const [event, reaction] of [
    ["APPROVE", "white_check_mark"],
    ["REQUEST_CHANGES", "request-changes"],
    ["COMMENT", "speech_balloon"],
  ] as const) {
    const posted = round({ number: 2, event });
    expect(roundEffects([posted], posted, "u")).toMatchObject([
      { key: `reaction:${reaction}`, kind: "reaction", content: reaction },
      { key: "reply:2", kind: "reply" },
    ]);
  }
});
