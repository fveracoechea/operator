import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync } from "unthrown";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { workerDevice } from "./worker-fixture.ts";
import { runAsk } from "./ask.ts";

const cwd = process.cwd();
let root = "";
afterEach(async () => {
  process.chdir(cwd);
  mock.restore();
  process.exitCode = 0;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

test("a failed question dispatch retains its registered source and owner metadata", async () => {
  const device = await workerDevice();
  root = device.root;
  const paths = OperatorHome.resolve(
    Environment.parse({
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      NODE_ENV: "test",
    }),
  );
  process.chdir(device.main);
  const calls = await device.herdrCalls();
  const next = {
    decider: "person" as const,
    question: "Which configuration owner should restore the selected host?",
  };
  const dispatch = spyOn(WorkerDispatch, "dispatch").mockReturnValue(
    ErrAsync({
      reason: "host_unavailable",
      detail: "The selected host is absent.",
      next,
      state: { executable: null },
    }),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const file = `${root}/question.txt`;
  await Bun.write(file, "Why did it stop?");
  expect(await runAsk(["ask", "--file", file], paths, true)).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  const input = dispatch.mock.calls[0]?.[0];
  expect(input?.assignment).toBe("why-did-it-stop");
  const sourceId = input?.sourceId ?? "";
  expect(sourceId).not.toBe("");
  const detail = `The selected host is absent. Source ${sourceId} holds the question. Run operator dispatch --source ${sourceId} --assignment why-did-it-stop again.`;
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      schemaVersion: 1,
      operation: "ask",
      outcome: "refused",
      reason: "host_unavailable",
      blockers: [{ reason: "host_unavailable", detail }],
      next,
      state: { executable: null },
    }),
  );
  expect(error.mock.calls.map(([line]) => String(line))).toEqual([
    `operator: host_unavailable: ${detail}`,
    `next: person decides: ${next.question}`,
    "state: executable=null",
  ]);
  const source = await WorkSources.show({ paths, cwd: device.main, sourceId });
  expect(source).toMatchObject({
    tag: "Ok",
    value: {
      repository: "example/one",
      launches: [],
      assignments: [{ key: "why-did-it-stop", state: "ready" }],
    },
  });
  expect(await device.herdrCalls()).toEqual(calls);
  expect(process.exitCode).toBe(3);
});
