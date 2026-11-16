import { afterEach, expect, test } from "bun:test";
// Bun has no temporary directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Obligations } from "./main.ts";

let root = "";
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("invalid obligation inputs expose their recovery without creating state", async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-obligation-input-"));
  const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
  const input = {
    paths,
    cwd: root,
    sourceId: "unchecked",
    file: `${root}/input.json`,
    key: "rule",
    kind: "standing-rule",
  };
  for (const text of ["", "{}"]) {
    await Bun.write(input.file, text);
    const result = await Obligations.add(input);
    expect(result).toMatchObject({
      tag: "Err",
      error: {
        reason: "invalid_obligation_input",
        next: {
          command:
            "operator obligation add --source <id> --key <key> --kind <kind> --file <path|->",
          why: "Correct the obligation flags or summary and try again.",
        },
        state: { inputValid: false },
      },
    });
    if (result.tag === "Err") expect(result.error.detail).toContain("Nothing changed.");
  }
  expect(await Obligations.add({ ...input, file: `${root}/missing.json` })).toMatchObject({
    tag: "Err",
    error: {
      reason: "obligation_io_failed",
      next: {
        decider: "super-agent",
        question: "How should the obligation IO failure be corrected before retrying?",
      },
      state: { code: "ENOENT" },
    },
  });
  expect(await Bun.file(paths.database).exists()).toBe(false);
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, dot: true }))).toEqual([
    "input.json",
  ]);
});
