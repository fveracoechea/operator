import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "./main.ts";

const root = "/isolated/supervision";
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
const input = { paths, cwd: root, sourceId: "s1" };
afterEach(() => {
  mock.restore();
});

function project() {
  spyOn(Projects, "current").mockReturnValue(
    OkAsync({
      reason: "project_resolved" as const,
      data: { repository: "example/one", checkout: root, registeredAt: "now" },
    }),
  );
}

function caller(session: string | undefined, pane: string | undefined = "pane-2") {
  spyOn(Environment, "read").mockReturnValue({
    ...Environment.read(),
    HERDR_PANE_ID: pane,
    OPENCODE_SESSION_ID: session,
    CLAUDE_CODE_SESSION_ID: undefined,
  });
}

function supervisor(value: { pane: string | null; session: string | null }) {
  return spyOn(DeviceState, "readSupervisor").mockReturnValue(Ok(value));
}

test("the supervising session, an unclaimed source, or a source that only a pane holds passes", async () => {
  project();
  caller("ses-1");
  const read = supervisor({ pane: "pane-1", session: "ses-1" });
  expect(await WorkSources.checkSupervisor(input)).toMatchObject({ tag: "Ok", value: undefined });
  expect(read).toHaveBeenCalledWith(paths, "example/one", "s1");
  for (const value of [
    { pane: null, session: null },
    { pane: "pane-1", session: null },
  ]) {
    read.mockReturnValueOnce(Ok(value));
    expect(await WorkSources.checkSupervisor(input)).toMatchObject({ tag: "Ok", value: undefined });
  }
});

test("another session, also one in the supervising pane, is refused with the supervisor and the take-over", async () => {
  project();
  supervisor({ pane: "pane-1", session: "ses-1" });
  for (const [session, pane] of [
    ["ses-2", "pane-2"],
    ["ses-2", "pane-1"],
    [undefined, undefined],
  ] as const) {
    caller(session, pane);
    const result = await WorkSources.checkSupervisor(input);
    expect(result).toMatchObject({
      tag: "Err",
      error: {
        reason: "source_supervised_elsewhere",
        next: {
          decider: "super-agent",
          question:
            "Will the recorded supervisor continue, or should the person authorize a source take-over?",
        },
        state: { supervisorSession: "ses-1", callerSession: session ?? null },
      },
    });
    const detail = result.tag === "Err" ? result.error.detail : "";
    expect(detail).toContain("session ses-1 in Herdr pane pane-1");
    expect(detail).toContain("operator source take-over --source s1 --person-instructed --json");
  }
  // A supervisor outside Herdr has no pane to name.
  supervisor({ pane: null, session: "ses-1" });
  caller("ses-2");
  expect(await WorkSources.checkSupervisor(input)).toMatchObject({
    error: { detail: expect.stringContaining("session ses-1 outside Herdr") as string },
  });
});

test("a supervision check that cannot read its source passes the failure on", async () => {
  project();
  caller("ses-1");
  const failure = { reason: "source_not_found" as const, detail: "missing" };
  spyOn(DeviceState, "readSupervisor").mockReturnValue(Err(failure));
  expect(await WorkSources.checkSupervisor(input)).toMatchObject({ tag: "Err", error: failure });
  const unregistered = { reason: "project_not_registered" as const, detail: "none" };
  spyOn(Projects, "current").mockReturnValue(ErrAsync(unregistered));
  expect(await WorkSources.checkSupervisor(input)).toMatchObject({
    tag: "Err",
    error: unregistered,
  });
});

test("a take-over needs the person's instruction and makes the caller the supervisor", async () => {
  project();
  caller("ses-2");
  const taken = spyOn(DeviceState, "takeOverSource").mockReturnValue(
    Ok({ pane: "pane-1", session: "ses-1" }),
  );
  expect(await WorkSources.takeOver({ ...input, personInstructed: false })).toMatchObject({
    tag: "Err",
    error: {
      reason: "person_instruction_required",
      next: { decider: "person", question: "May this command run on your explicit instruction?" },
      state: { personInstructed: false },
    },
  });
  expect(taken).not.toHaveBeenCalled();
  expect(await WorkSources.takeOver({ ...input, personInstructed: true })).toMatchObject({
    tag: "Ok",
    value: {
      sourceId: "s1",
      previous: { pane: "pane-1", session: "ses-1" },
      supervisor: { pane: "pane-2", session: "ses-2" },
    },
  });
  expect(taken).toHaveBeenCalledWith(paths, "example/one", "s1", {
    pane: "pane-2",
    session: "ses-2",
  });
});
