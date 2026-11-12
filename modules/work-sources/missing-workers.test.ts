import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { missingWorkers } from "./missing-workers.ts";

const worker = {
  id: "launch-1",
  name: "worker-one",
  state: "running",
  paneId: "w1:p1",
  herdrSocket: "/herdr.sock",
};

beforeEach(() => {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: "/herdr.sock",
  });
  spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([]));
});
afterEach(() => mock.restore());

test("only a missing pane and missing named agent authorize the recorded launch", async () => {
  const result = await missingWorkers([worker]);
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  expect(result.value(worker)).toBe(true);
  for (const changed of [
    { id: "launch-2" },
    { name: "replacement" },
    { state: "starting" },
    { paneId: "w1:p2" },
    { herdrSocket: "/other.sock" },
  ])
    expect(result.value({ ...worker, ...changed })).toBe(false);
  expect(Herdr.pane).toHaveBeenCalledWith("w1:p1");
});

test("multiple candidates keep separate identities", async () => {
  const other = { ...worker, id: "launch-2", name: "worker-two", paneId: "w1:p2" };
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([other.name]));
  const result = await missingWorkers([worker, other]);
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return;
  expect(result.value(worker)).toBe(true);
  expect(result.value(other)).toBe(false);
});

test("a live pane or a named agent moved elsewhere stays protected", async () => {
  spyOn(Herdr, "pane").mockReturnValue(OkAsync({ tabId: "w1:t1", workspaceId: "w1" }));
  const live = await missingWorkers([worker]);
  expect(live.tag).toBe("Ok");
  if (live.tag === "Ok") expect(live.value(worker)).toBe(false);
  spyOn(Herdr, "pane").mockReturnValue(OkAsync(null));
  spyOn(Herdr, "agentNames").mockReturnValue(OkAsync([worker.name]));
  const moved = await missingWorkers([worker]);
  expect(moved.tag).toBe("Ok");
  if (moved.tag === "Ok") expect(moved.value(worker)).toBe(false);
});

test("starts, ended launches, and incomplete or mismatched identities need no Herdr query", async () => {
  for (const changed of [
    { state: "starting" },
    { state: "finished" },
    { state: "interrupted" },
    { state: "failed" },
    { name: "" },
    { paneId: null },
    { paneId: "" },
    { herdrSocket: null },
    { herdrSocket: "" },
    { herdrSocket: "/other.sock" },
  ]) {
    const candidate = { ...worker, ...changed };
    const result = await missingWorkers([candidate]);
    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") expect(result.value(candidate)).toBe(false);
  }
  const empty = await missingWorkers([]);
  expect(empty.tag).toBe("Ok");
  if (empty.tag === "Ok") expect(empty.value(worker)).toBe(false);
  expect(Herdr.pane).not.toHaveBeenCalled();
  expect(Herdr.agentNames).not.toHaveBeenCalled();
});

test("an absent current socket cannot authorize a missing worker", async () => {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_SOCKET_PATH: undefined,
  });
  const result = await missingWorkers([worker]);
  expect(result.tag).toBe("Ok");
  if (result.tag === "Ok") expect(result.value(worker)).toBe(false);
  expect(Herdr.agentNames).not.toHaveBeenCalled();
});

test("a failed pane query discards earlier missing observations", async () => {
  const failure = { reason: "herdr_no_answer", detail: "No answer." } as const;
  spyOn(Herdr, "pane").mockReturnValueOnce(OkAsync(null)).mockReturnValue(ErrAsync(failure));
  expect(
    await missingWorkers([worker, { ...worker, id: "launch-2", paneId: "w1:p2" }]),
  ).toMatchObject({ tag: "Err", error: failure });
});

test("a failed agent query never authorizes retirement", async () => {
  const failure = { reason: "herdr_invalid_response", detail: "Ambiguous names." } as const;
  spyOn(Herdr, "agentNames").mockReturnValue(ErrAsync(failure));
  expect(await missingWorkers([worker])).toMatchObject({ tag: "Err", error: failure });
  expect(Herdr.pane).not.toHaveBeenCalled();
});

test("an unexpected query exception remains a defect", async () => {
  const cause = new TypeError("query defect");
  spyOn(Herdr, "pane").mockImplementationOnce(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the Herdr boundary.
    throw cause;
  });
  expect(await missingWorkers([worker])).toMatchObject({ tag: "Defect", cause });
});
