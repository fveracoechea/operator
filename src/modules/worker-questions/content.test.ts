import { expect, test } from "bun:test";
import {
  answerKey,
  answerSchema,
  doorbell,
  messageSchema,
  questionSchema,
  replySchema,
} from "./content.ts";

test("a question has a hyphenated lowercase key and trimmed text", () => {
  expect(questionSchema.parse({ key: "scope-2", question: "  Which scope?  " })).toEqual({
    key: "scope-2",
    question: "Which scope?",
  });
  for (const key of ["", "Scope", "-scope", "scope-", "a--b", "a_b", "a".repeat(65)])
    expect(questionSchema.safeParse({ key, question: "Which?" }).success).toBe(false);
  expect(questionSchema.safeParse({ key: "a".repeat(64), question: "Which?" }).success).toBe(true);
  expect(questionSchema.safeParse({ key: "scope", question: "   " }).success).toBe(false);
  expect(questionSchema.safeParse({ key: "scope", question: "a".repeat(4001) }).success).toBe(
    false,
  );
  expect(questionSchema.safeParse({ key: "scope", question: "a".repeat(4000) }).success).toBe(true);
  // An unknown field is a mistake in the draft, not something to ignore.
  expect(questionSchema.safeParse({ key: "scope", question: "Which?", by: "x" }).success).toBe(
    false,
  );
});

test("an answer is trimmed text of bounded length", () => {
  expect(answerSchema.parse("  Use reader.\n")).toBe("Use reader.");
  expect(answerSchema.safeParse(" \n").success).toBe(false);
  expect(answerSchema.safeParse("a".repeat(4001)).success).toBe(false);
  expect(answerSchema.safeParse("a".repeat(4000)).success).toBe(true);
});

test("a steering message has a question-style key and trimmed text", () => {
  expect(messageSchema.parse({ key: "focus", message: "  Stop.  " })).toEqual({
    key: "focus",
    message: "Stop.",
  });
  // A colon is reserved for answer keys, so a sent key never collides with one.
  for (const key of ["answer:scope", "Focus", ""])
    expect(messageSchema.safeParse({ key, message: "Stop." }).success).toBe(false);
  expect(messageSchema.safeParse({ key: "focus", message: " " }).success).toBe(false);
  expect(messageSchema.safeParse({ key: "focus", message: "a".repeat(4001) }).success).toBe(false);
  expect(messageSchema.safeParse({ key: "focus", message: "a".repeat(4000) }).success).toBe(true);
  expect(messageSchema.safeParse({ key: "focus", message: "Stop.", to: "x" }).success).toBe(false);
  expect(replySchema.parse(" Done.\n")).toBe("Done.");
});

test("an answer key and a doorbell name the record and nothing else", () => {
  expect(answerKey("scope")).toBe("answer:scope");
  expect(doorbell("answer:scope")).toBe("Operator recorded steering message answer:scope for you.");
});
