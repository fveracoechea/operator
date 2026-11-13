import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no recursive removal API.
import { rm } from "node:fs/promises";
import { workerDevice } from "./worker-fixture.ts";

let device: Awaited<ReturnType<typeof workerDevice>>;
beforeEach(async () => {
  device = await workerDevice();
});
afterEach(async () => {
  await rm(device.root, { recursive: true, force: true });
});

const plan = {
  trackerKey: "github:example/one#10",
  assignments: [
    {
      key: "read",
      trackerKey: "github:example/one#11",
      instructions: "Read and report.",
      completion: "report",
      resources: "pane",
      dependencies: [],
    },
  ],
};

test("question ask reads plain text from --file - and keeps shell punctuation", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "read");
  const question = "Is `a.ts` in scope?\nKeep $HOME and 'quotes' literal.";
  const result = await device.run(["question", "ask", "--key", "scope", "--file", "-"], {
    pane: worker.paneId,
    stdin: question,
  });
  expect(result).toMatchObject({
    code: 0,
    output: { reason: "question_asked", data: { key: "scope", question } },
  });
  const actions = await device.next("read");
  expect(actions.find((row) => row.action === "answer_question")).toMatchObject({
    question: { key: "scope", question },
  });
}, 120000);

const report = `## Conclusion
Only a.ts needs work.

## Evidence
- Read \`a.ts\`.
- Ran the focused tests.

## Unresolved points
- None.

## Supporting files
- None.

## Human answers
- Scope? Answer: Only a.ts.

## SuperAgent decisions
- Test seam? Answer: Use the CLI.
`;

test("report submit reads markdown from --file - and separates answer authority", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "read");
  const result = await device.run(["report", "submit", "--file", "-"], {
    pane: worker.paneId,
    stdin: report,
  });
  expect(result).toMatchObject({
    code: 0,
    output: { reason: "report_submitted", data: { state: "reported" } },
  });
  const stored = await Bun.file(
    `${device.root}/state/operator/projects/example/one/sources/${source}/assignments/read/reports/1/report.md`,
  ).text();
  expect(stored).toContain("## Human answers\n\n- Scope? Answer: Only a.ts.");
  expect(stored).toContain("- Test seam? Answer: Use the CLI.");
  expect(stored).toContain("- Read `a.ts`.");
}, 120000);

test("report submit refuses a missing or unknown heading with next", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "read");
  for (const invalid of [
    report.replace("## Evidence", "## Proof"),
    report.replace("## Evidence\n- Read `a.ts`.\n- Ran the focused tests.\n", ""),
  ]) {
    expect(
      await device.run(["report", "submit", "--file", "-"], {
        pane: worker.paneId,
        stdin: invalid,
      }),
    ).toMatchObject({
      code: 2,
      output: {
        reason: "invalid_report_input",
        next: { command: "operator report submit --file <path|->" },
      },
    });
  }
  expect(await device.next("read")).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ action: "review_report" })]),
  );
}, 120000);

test("text commands refuse legacy JSON envelopes and removed inline flags", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "read");
  const selector = ["--source", source, "--assignment", "read"];
  const question = await device.writeJson("old-question.json", {
    key: "scope",
    question: "Which file?",
  });
  const message = await device.writeJson("old-message.json", { key: "focus", message: "Stop." });
  const calls = await device.herdrCalls();
  const oldReport = await device.writeJson("old-report.json", {
    conclusion: "Done.",
    evidence: ["Read a.ts"],
    unresolved: [],
  });
  expect(
    await device.run(["question", "ask", "--file", question], { pane: worker.paneId }),
  ).toMatchObject({ code: 2, output: { reason: "invalid_arguments" } });
  expect(await device.run(["message", "send", ...selector, "--file", message])).toMatchObject({
    code: 2,
    output: { reason: "invalid_arguments" },
  });
  expect(
    await device.run(["report", "submit", "--file", oldReport], { pane: worker.paneId }),
  ).toMatchObject({ code: 2, output: { reason: "invalid_report_input" } });
  expect(
    await device.run(["message", "send", ...selector, "--key", "focus", "--text", "Stop."]),
  ).toMatchObject({ code: 2 });
  expect(
    await device.run([
      "question",
      "answer",
      ...selector,
      "--key",
      "scope",
      "--by",
      "person",
      "--text",
      "No.",
    ]),
  ).toMatchObject({ code: 2 });
  expect((await device.next("read")).map((row) => row.action)).toEqual(["wait"]);
  expect(await device.herdrCalls()).toEqual(calls);
}, 120000);

test("malformed report bullets and duplicate headings refuse without recording a report", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "read");
  for (const invalid of [
    `${report}\n## Conclusion\nOverwritten.`,
    report.replace("Scope? Answer: Only a.ts.", "Scope? Only a.ts."),
    report.replace("- Read `a.ts`.", "Read `a.ts`."),
    report.replace("## Supporting files\n- None.", "## Supporting files\n- relative.md"),
  ]) {
    expect(
      await device.run(["report", "submit", "--file", "-"], {
        pane: worker.paneId,
        stdin: invalid,
      }),
    ).toMatchObject({ code: 2, output: { reason: "invalid_report_input" } });
  }
  expect((await device.next("read")).map((row) => row.action)).toEqual(["wait"]);
  const file = await device.writeText("report.md", report);
  expect(
    await device.run(["report", "submit", "--file", file], { pane: worker.paneId }),
  ).toMatchObject({ code: 0 });
}, 120000);

test("message send, message ack, and question answer read text from --file -", async () => {
  const source = await device.register(plan);
  const worker = await device.dispatch(source, "read");
  const selector = ["--source", source, "--assignment", "read"];
  expect(
    await device.run(["message", "send", ...selector, "--key", "focus", "--file", "-"], {
      stdin: "Keep `a.ts`.\nNo other files.",
    }),
  ).toMatchObject({
    code: 0,
    output: { data: { key: "focus", message: "Keep `a.ts`.\nNo other files." } },
  });
  expect(
    await device.run(["message", "ack", "--key", "focus", "--file", "-"], {
      pane: worker.paneId,
      stdin: "Understood.\nI will keep $HOME literal.",
    }),
  ).toMatchObject({
    code: 0,
    output: { data: { state: "replied", reply: "Understood.\nI will keep $HOME literal." } },
  });
  expect(
    await device.run(["question", "ask", "--key", "scope", "--file", "-"], {
      pane: worker.paneId,
      stdin: "Which file?",
    }),
  ).toMatchObject({ code: 0 });
  expect(
    await device.run(
      ["question", "answer", ...selector, "--key", "scope", "--by", "super-agent", "--file", "-"],
      { stdin: "Only `a.ts`.\nKeep 'quotes'." },
    ),
  ).toMatchObject({
    code: 0,
    output: { data: { by: "super-agent", answer: "Only `a.ts`.\nKeep 'quotes'." } },
  });
}, 120000);
