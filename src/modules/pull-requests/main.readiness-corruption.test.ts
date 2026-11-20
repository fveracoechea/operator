import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DeviceState } from "../device-state/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { PullRequests } from "./main.ts";
import {
  git,
  prDevice,
  pullRequestBody,
  requestKind,
  succeeded,
  mergeRequest,
} from "./device-fixture.ts";

afterEach(() => mock.restore());

test.each(["{", "{}", ""])(
  "corrupt readiness %j refuses public merge before GitHub or cleanup",
  async (readiness) => {
    await using device = await prDevice();
    const worker = device.start("other", {
      kind: JSON.stringify(WorkerKinds.resolve("implementation")),
    });
    device.associate(worker.launchId, 7, "task/other");
    const head = git(worker.worktree, "rev-parse", "HEAD");
    const detach = spyOn(ToolInvocation, "detach").mockReturnValue(process.ppid);
    let landed = false;
    device.answer((args) => {
      if (requestKind(args) === "merge") {
        landed = true;
        return mergeRequest("merged");
      }
      return succeeded(
        pullRequestBody(landed ? { state: "MERGED", head, mergeCommit: "m1" } : { head }),
      );
    });
    const input = { paths: device.paths, cwd: worker.worktree };
    expect(await PullRequests.merge(input)).toMatchObject({
      tag: "Err",
      error: { reason: "pr_merge_blocked" },
    });
    device.calls.length = 0;
    using client = new Database(device.paths.database);
    client
      .query("UPDATE pull_requests SET readiness = ? WHERE assignment = 'other'")
      .run(readiness);
    const before = client.serialize();
    expect(
      await WorkSources.show({
        paths: device.paths,
        cwd: device.checkout,
        sourceId: device.sourceId,
      }),
    ).toMatchObject({ tag: "Err", error: { reason: "state_corrupt" } });
    expect(await PullRequests.merge(input)).toMatchObject({
      tag: "Err",
      error: { reason: "state_corrupt" },
    });
    expect(DeviceState.worktreeOwners(device.paths)).toMatchObject({
      tag: "Err",
      error: { reason: "state_corrupt" },
    });
    expect(device.calls).toEqual([]);
    expect(landed).toBe(false);
    expect(detach).not.toHaveBeenCalled();
    expect(client.serialize()).toEqual(before);
  },
);
