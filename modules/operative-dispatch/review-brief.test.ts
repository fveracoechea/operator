import { expect, test } from "bun:test";
import { reviewProtocolSection, type ReviewBrief } from "./review-brief.ts";

const review: ReviewBrief = {
  reviewId: "review-1",
  attemptId: "attempt-1",
  submissionId: "submission-1",
  submissionIdentity: "identity",
  resultKind: "code",
  axes: ["standards", "spec"],
  requiredCoverage: ["diff", "requirements", "checks", "behavior-changes"],
  producerAssignmentId: "assignment-1",
  producerTitle: "Test",
  assignmentRevision: 1,
  sourceRevision: "revision",
  requirementsIdentity: "requirements",
  reviewBase: null,
  code: null,
  checks: [],
  concerns: [],
  decisions: [],
  behaviorChanges: [],
  artifacts: [],
  spec: null,
  fixedPoint: null,
  readCommands: [],
  integration: null,
  priorRounds: [],
};

test("reviewer protocol uses the selected JSR invocation", () => {
  const protocol = reviewProtocolSection(review, [], "bun run operator").join("\n");
  expect(protocol).toContain("bun run operator attempt acknowledge --request");
  expect(protocol).toContain("bun run operator review report --request");
});

test("reviewer protocol uses the pinned source invocation", () => {
  const command = `bunx "github:fveracoechea/operator#${"f".repeat(40)}"`;
  const protocol = reviewProtocolSection(review, [], command).join("\n");
  expect(protocol).toContain(`${command} attempt acknowledge --request`);
  expect(protocol).toContain(`${command} review report --request`);
});
