import { expect, test } from "bun:test";
import { superAgentMessages } from "./superagent-messages.ts";

test("finds each line that tells a worker to message its SuperAgent", () => {
  expect(
    superAgentMessages(
      [
        "Then tell your SuperAgent through Herdr that the report is submitted.",
        "Tell your supervising SuperAgent that the draft PR is ready.",
        "If it was closed, stop and tell the SuperAgent.",
        "- Report to your supervising SuperAgent through Herdr, not directly to the person.",
        "Message its SuperAgent in Herdr.",
        "Notify your SuperAgent.",
        "Inform the SuperAgent.",
        "Ping your SuperAgent over Herdr.",
        "Reach the SuperAgent via Herdr.",
        "Send the result to your SuperAgent.",
        "Let your supervising SuperAgent know.",
      ].join("\n"),
    ).map(({ line }) => line),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("numbers each found line from 1", () => {
  expect(superAgentMessages("Read the brief.\nTell your SuperAgent.")).toEqual([
    { line: 2, text: "Tell your SuperAgent." },
  ]);
});

test("keeps recorded mechanisms and Herdr uses that do not reach the SuperAgent", () => {
  expect(
    superAgentMessages(
      [
        "Ask your supervising SuperAgent with `operator question ask`.",
        "Your SuperAgent's coordination wait returns the submitted report.",
        "Never type a reply into the SuperAgent's pane.",
        "Inside Herdr, name your tab for the work.",
        "Herdr activity does not prove that the work is submitted.",
        "The SuperAgent reads it. Herdr shows the pane.",
        "A SuperAgent told you not to merge.",
        "Ask each question of your supervising SuperAgent, not of the person.",
        "Request it in a recorded question to your supervising SuperAgent.",
      ].join("\n"),
    ),
  ).toEqual([]);
});
