import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerDispatch } from "../worker-dispatch/main.ts";
import { Herdr } from "../herdr/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { prDevice, repository } from "./device-fixture.ts";
import { dispatch, dispatchPermission, startHandoff } from "./internal-review.ts";
import { resolveOwner } from "./owner.ts";

afterEach(() => mock.restore());

const recovery = {
  decider: "super-agent" as const,
  question:
    "How should the failed internal-review handoff be recovered from its recorded progress?",
};

test.each([null, 0, -1, 12] as const)(
  "permission preserves supervisor refusal for publication PID %s",
  async (afterPid) => {
    await using device = await prDevice();
    const refusal = {
      reason: "source_not_found" as const,
      detail: "No such source.",
      next: { command: "operator next", why: "Read sources." },
    };
    spyOn(WorkSources, "checkSupervisor").mockReturnValue(ErrAsync(refusal));
    const project = spyOn(Projects, "current");
    const claim = spyOn(DeviceState, "claimHandoff");
    const result = await dispatchPermission({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid,
    });
    expect(result).toMatchObject({ tag: "Err", error: refusal });
    expect(project).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  },
);

test.each([null, 0, -1] as const)(
  "foreign supervision cannot authorize publication PID %s",
  async (afterPid) => {
    await using device = await prDevice();
    const refusal = {
      reason: "source_supervised_elsewhere" as const,
      detail: "Foreign supervisor.",
      next: { command: "operator next", why: "Read authority." },
    };
    spyOn(WorkSources, "checkSupervisor").mockReturnValue(ErrAsync(refusal));
    const project = spyOn(Projects, "current");
    const input = {
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid,
    };
    expect(await dispatchPermission(input)).toMatchObject(
      afterPid === null
        ? { tag: "Err", error: refusal }
        : {
            tag: "Err",
            error: {
              reason: "handoff_continuation_refused",
              detail:
                "An internal continuation needs a positive publication PID and its own recorded hold.",
              next: recovery,
              state: { continuationAuthorized: false },
            },
          },
    );
    expect(project).not.toHaveBeenCalled();
  },
);

test("publication preserves a project refusal and its next action", async () => {
  await using device = await prDevice();
  spyOn(WorkSources, "checkSupervisor").mockReturnValue(OkAsync(undefined));
  const refusal = {
    reason: "project_not_registered" as const,
    detail: "Register first.",
    next: { command: "operator project register", why: "Register." },
  };
  spyOn(Projects, "current").mockReturnValue(ErrAsync(refusal));
  const read = spyOn(DeviceState, "readHandoffContinuation");
  expect(
    await dispatchPermission({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: 12,
    }),
  ).toMatchObject({
    tag: "Err",
    error: refusal,
  });
  expect(read).not.toHaveBeenCalled();
});

test.each(["published", "timeout", "refused"] as const)(
  "publication %s retains exact identity and refuses without effects",
  async (outcome) => {
    await using device = await prDevice();
    spyOn(WorkSources, "checkSupervisor").mockReturnValue(
      ErrAsync({
        reason: "source_supervised_elsewhere",
        detail: "Foreign supervisor.",
        next: recovery,
      }),
    );
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_PANE_ID: "worker",
      HERDR_SOCKET_PATH: "/fixture.sock",
    });
    const identity = {
      repository,
      sourceId: device.sourceId,
      assignment: "parent",
      outgoingLaunchId: "outgoing",
      nextKind: "review",
      startedAt: "before",
      pane: "worker",
      socket: "/fixture.sock",
    };
    const refusal = {
      reason: "handoff_continuation_refused" as const,
      detail: "Wrong owner.",
      next: { command: "operator next", why: "Recover." },
      state: { continuationAuthorized: false },
    };
    let reads = 0;
    const read = spyOn(DeviceState, "readHandoffContinuation").mockImplementation(() => {
      reads++;
      // A second refusal makes a mutant that omits the deadline fail, rather than wait forever.
      if (outcome === "refused" || (outcome === "timeout" && reads > 1) || reads > 2)
        return Err(refusal);
      return Ok({ identity, published: outcome === "published" && reads > 1 });
    });
    const now = spyOn(Date, "now");
    now.mockReturnValueOnce(1000).mockReturnValue(outcome === "timeout" ? 2000 : 1000);
    const claim = spyOn(DeviceState, "claimHandoff");
    const close = spyOn(Herdr, "closePane");
    const launch = spyOn(WorkerDispatch, "dispatch");
    const result = await dispatchPermission({
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
      afterPid: 12,
    });
    expect(read.mock.calls[0]).toEqual([
      device.paths,
      { repository, sourceId: device.sourceId, assignment: "parent" },
      { pane: "worker", socket: "/fixture.sock" },
      12,
    ]);
    expect(reads).toBe(outcome === "published" ? 2 : 1);
    expect(result).toMatchObject(
      outcome === "published"
        ? { tag: "Ok", value: { continuation: identity } }
        : outcome === "refused"
          ? { tag: "Err", error: refusal }
          : {
              tag: "Err",
              error: {
                reason: "handoff_publication_timed_out",
                detail:
                  "The associating process did not publish this continuation's PID within one second. No handoff was claimed.",
                next: {
                  command: "operator next",
                  why: "The supervisor can recover the stopped handoff.",
                },
                state: { continuationAuthorized: false },
              },
            },
    );
    expect(claim).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "a successful dispatch retains its successor with internal continuation=%s",
  async (internal) => {
    await using device = await prDevice();
    const socket = `${device.root}/herdr.sock`;
    const owner = device.start("parent", { socket });
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        owner.launchId,
        {
          number: 7,
          url: `https://github.com/${repository}/pull/7`,
          branch: "task/parent",
          relay: null,
        },
        false,
        true,
      ).tag,
    ).toBe("Ok");
    expect(DeviceState.startHandoff(device.paths, device.sourceId, "parent", process.pid).tag).toBe(
      "Ok",
    );
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_PANE_ID: "p1",
      HERDR_SOCKET_PATH: socket,
    });
    spyOn(WorkSources, "checkSupervisor").mockReturnValue(OkAsync(undefined));
    spyOn(WorkerDispatch, "checkHandoff").mockReturnValue(OkAsync(undefined));
    const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
    // The dispatcher's public result is opaque to this orchestrator. Preserve its identity.
    const successor = { paneId: "reviewer", assignment: "parent" };
    const launched = spyOn(WorkerDispatch, "dispatch").mockReturnValue(OkAsync(successor) as never);
    const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    expect(await exited.exited).toBe(0);
    const input: Parameters<typeof dispatch>[0] = {
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
    };
    if (internal) input.afterPid = exited.pid;
    expect(await dispatch(input)).toMatchObject({ tag: "Ok", value: successor });
    expect(close.mock.calls).toEqual([["p1"]]);
    expect<unknown>(launched.mock.calls).toEqual([
      [
        {
          paths: device.paths,
          cwd: device.checkout,
          sourceId: device.sourceId,
          assignment: "parent",
          handoff: true,
          continuation: internal
            ? {
                repository,
                sourceId: device.sourceId,
                assignment: "parent",
                outgoingLaunchId: owner.launchId,
                startedAt: expect.any(String) as unknown,
                nextKind: "review",
                pane: "p1",
                socket,
              }
            : undefined,
        },
      ],
    ]);
    expect(DeviceState.readSources(device.paths, repository, device.sourceId)).toMatchObject({
      tag: "Ok",
      value: [{ launches: [{ state: "finished" }] }],
    });
  },
);

test.each(["missing", "empty", "other", "done", "pending"] as const)(
  "supervisor dispatch selects only its %s handoff",
  async (state) => {
    await using device = await prDevice();
    const owner = device.start("parent");
    spyOn(Environment, "read").mockReturnValue({
      ...Environment.read(),
      HERDR_SOCKET_PATH: `${device.root}/herdr.sock`,
    });
    expect(
      DeviceState.associatePullRequest(
        device.paths,
        owner.launchId,
        {
          number: 7,
          url: `https://github.com/${repository}/pull/7`,
          branch: "task/parent",
          relay: null,
        },
        false,
        true,
      ).tag,
    ).toBe("Ok");
    spyOn(WorkSources, "checkSupervisor").mockReturnValue(OkAsync(undefined));
    const original = WorkSources.show;
    spyOn(WorkSources, "show").mockImplementation((input) =>
      original(input).map((source) => {
        if (source === undefined || state === "missing") return undefined;
        const handoff = source.handoffs[0];
        if (handoff === undefined) return expect.unreachable("Association records its handoff.");
        return {
          ...source,
          handoffs:
            state === "empty"
              ? []
              : [
                  {
                    ...handoff,
                    assignment: state === "other" ? "other" : "parent",
                    handoffState: state === "done" ? "done" : "pending",
                  },
                ],
        };
      }),
    );
    const refusal = {
      reason: "launch_failed",
      detail: "Controlled launch refusal.",
      next: { command: "operator next", why: "Recover." },
    };
    const launched = spyOn(WorkerDispatch, "dispatch").mockReturnValue(ErrAsync(refusal));
    const preflight = spyOn(WorkerDispatch, "checkHandoff").mockReturnValue(OkAsync(undefined));
    const close = spyOn(Herdr, "closePane").mockReturnValue(OkAsync("closed" as const));
    const input = {
      paths: device.paths,
      cwd: device.checkout,
      sourceId: device.sourceId,
      assignment: "parent",
    };
    expect(await dispatch(input)).toMatchObject({ tag: "Err", error: refusal });
    expect(launched.mock.calls).toEqual([
      [state === "pending" ? { ...input, handoff: true, continuation: undefined } : input],
    ]);
    expect(preflight).toHaveBeenCalledTimes(state === "pending" ? 1 : 0);
    expect(close).toHaveBeenCalledTimes(state === "pending" ? 1 : 0);
  },
);

test("the detached closing command publishes the exact internal dispatch and its process hold", async () => {
  await using device = await prDevice();
  const owner = device.start("parent");
  const resolved = await resolveOwner({ paths: device.paths, cwd: owner.worktree });
  if (resolved.tag !== "Ok") return expect.unreachable("The fixture has an owner.");
  const detached = spyOn(ToolInvocation, "detach").mockReturnValue(123);
  const start = spyOn(DeviceState, "startHandoff").mockReturnValue(Ok(undefined));
  expect(await startHandoff(device.paths, resolved.value)).toMatchObject({
    tag: "Ok",
    value: "started",
  });
  expect(detached.mock.calls).toEqual([
    [
      {
        tool: process.execPath,
        args: [
          Bun.fileURLToPath(new URL("../../cli.ts", import.meta.url)),
          "dispatch",
          "--source",
          device.sourceId,
          "--assignment",
          "parent",
          "--after-pid",
          String(process.pid),
          "--json",
        ],
        cwd: device.checkout,
      },
    ],
  ]);
  expect(start.mock.calls).toEqual([[device.paths, device.sourceId, "parent", 123]]);
});
