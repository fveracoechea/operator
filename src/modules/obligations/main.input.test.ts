import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { Obligations } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-obligation-input-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
const input = {
  paths,
  cwd: root,
  sourceId: "input",
  key: "hold",
  kind: "merge-hold",
  file: `${root}/summary.txt`,
};

beforeEach(() => {
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved",
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
});
afterEach(() => mock.restore());
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("plain-text summaries and flags reach the real ledger after trimming", async () => {
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/one",
      checkout: root,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  expect(
    DeviceState.registerSource(
      paths,
      root,
      {
        id: input.sourceId,
        repository: "example/one",
        trackerKey: "APP-1",
        state: "open",
        registeredAt: "now",
        endedAt: null,
        plan: "{}",
      },
      [],
    ).tag,
  ).toBe("Ok");
  const examples: [string, string, string][] = [
    ["hold", "  Keep `main` on hold.\nUntil approval.\n", "Keep `main` on hold.\nUntil approval."],
    ["bracket", "[Hold] Wait for approval.", "[Hold] Wait for approval."],
    ["brace", "{Reminder} Ask first.", "{Reminder} Ask first."],
    ["limit", "x".repeat(2000), "x".repeat(2000)],
  ];
  for (const [key, text, summary] of examples) {
    await Bun.write(input.file, text);
    expect(await Obligations.add({ ...input, key, reference: "  PR-12  " })).toMatchObject({
      tag: "Ok",
      value: {
        reason: "obligation_added",
        data: { key, kind: "merge-hold", summary, reference: "PR-12", state: "open" },
      },
    });
  }
  await Bun.write(input.file, "Share the PR.");
  expect(await Obligations.add({ ...input, key: "share", kind: "pr-share" })).toMatchObject({
    tag: "Ok",
    value: { data: { key: "share", kind: "pr-share", reference: null, summary: "Share the PR." } },
  });
  expect(await Obligations.list(input)).toMatchObject({
    tag: "Ok",
    value: {
      data: {
        obligations: [
          { key: "hold", summary: "Keep `main` on hold.\nUntil approval.", reference: "PR-12" },
          { key: "bracket", summary: "[Hold] Wait for approval." },
          { key: "brace", summary: "{Reminder} Ask first." },
          { key: "limit", summary: "x".repeat(2000) },
          { key: "share", reference: null },
        ],
      },
    },
  });
});

test.each([
  "",
  " \n",
  "x".repeat(2001),
  "[]",
  '"Hold it."',
  "123",
  "true",
  "false",
  "null",
  '{"summary":"Hold it."}',
])("invalid summaries refuse before project lookup or storage (%s)", async (summary) => {
  const project = spyOn(Projects, "current");
  const write = spyOn(DeviceState, "changeObligation");
  await Bun.write(input.file, summary);
  const result = await Obligations.add(input);
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "invalid_obligation_input",
      next: {
        command: "operator obligation add --source <id> --key <key> --kind <kind> --file <path|->",
      },
    },
  });
  expect(project).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  if (result.tag !== "Err") return expect.unreachable("invalid summary accepted");
  expect(result.error.detail).toContain("JSON is not accepted.");
  if (!("next" in result.error)) return expect.unreachable("missing next command");
  expect(result.error.next.why).toMatch(/\S/);
});

test.each([
  { key: "Bad-Key" },
  { key: "-bad" },
  { key: "x".repeat(65) },
  { kind: "unknown" },
  { reference: " " },
  { reference: "x".repeat(2001) },
])("invalid flags refuse before writing (%j)", async (flags) => {
  const write = spyOn(DeviceState, "changeObligation");
  await Bun.write(input.file, "Hold the merge.");
  expect(await Obligations.add({ ...input, ...flags })).toMatchObject({
    tag: "Err",
    error: { reason: "invalid_obligation_input" },
  });
  expect(write).not.toHaveBeenCalled();
});

test("an unreadable summary is an I/O refusal without project lookup", async () => {
  const project = spyOn(Projects, "current");
  expect(await Obligations.add({ ...input, file: `${root}/missing` })).toMatchObject({
    tag: "Err",
    error: { reason: "obligation_io_failed" },
  });
  expect(project).not.toHaveBeenCalled();
});

test("the module reads JSON from real stdin and refuses it before project lookup", async () => {
  const module = new URL("./main.ts", import.meta.url).href;
  const home = new URL("../operator-home/main.ts", import.meta.url).href;
  const environment = new URL("../environment/main.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { Obligations } from ${JSON.stringify(module)};
    import { OperatorHome } from ${JSON.stringify(home)};
    import { Environment } from ${JSON.stringify(environment)};
    const paths = OperatorHome.resolve(Environment.parse({ HOME: ${JSON.stringify(root)}, NODE_ENV: "test" }));
    console.log(JSON.stringify(await Obligations.add({ paths, cwd: ${JSON.stringify(root)}, sourceId: "input", key: "stdin", kind: "merge-hold", file: "-" })));
  `,
    ],
    { cwd: root, stdin: new Blob(['{"summary":"hold"}']), stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout) as unknown).toMatchObject({
    tag: "Err",
    error: { reason: "invalid_obligation_input" },
  });
});
