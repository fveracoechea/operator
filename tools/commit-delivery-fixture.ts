import { expect, spyOn } from "bun:test";
// Bun has no temporary directory or recursive directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { z } from "zod";
import { DeviceState } from "../src/modules/device-state/main.ts";
import { Environment } from "../src/modules/environment/main.ts";
import { OperatorHome } from "../src/modules/operator-home/main.ts";
import { ToolInvocation } from "../src/modules/tool-invocation/main.ts";
import { WorkerKinds } from "../src/modules/worker-kinds/main.ts";
import { CommitDelivery } from "../src/modules/commit-delivery/main.ts";

export async function commitFixture(checks: string[][] = [["git", "diff", "--exit-code"]]) {
  const root = await mkdtemp("/tmp/opencode/commit-fixture-");
  const environment = {
    ...Environment.read(),
    OPENCODE_SESSION_ID: undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
    HOME: root,
    XDG_STATE_HOME: `${root}/state`,
    XDG_CONFIG_HOME: `${root}/config`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    HERDR_SOCKET_PATH: `${root}/socket`,
    HERDR_PANE_ID: "implementer",
  };
  spyOn(Environment, "read").mockReturnValue(environment);
  const paths = OperatorHome.resolve(environment);
  const checkout = `${root}/checkout`;
  const worktree = `${root}/ticket`;
  const origin = `${root}/origin.git`;
  function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: Environment.child() });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  }

  git(root, "init", "-q", "-b", "main", checkout);
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  await Bun.write(`${checkout}/base`, "base\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "base");
  git(checkout, "remote", "add", "origin", "https://github.com/example/one.git");
  git(checkout, "push", origin, "main");
  const base = git(checkout, "rev-parse", "HEAD");
  git(checkout, "worktree", "add", "-qb", "ticket/411", worktree, base);
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/one",
      checkout,
      registeredAt: "2026-11-21",
    }).tag,
  ).toBe("Ok");
  const plan = {
    trackerKey: "#411",
    assignments: [
      {
        key: "ticket",
        trackerKey: "#411",
        kind: "commit-implementation",
        completion: "commit",
        resources: "worktree",
        branch: "ticket/411",
        instructions: "Implement the feature.",
        dependencies: [],
        delivery: { checks },
      },
    ],
  };
  expect(
    DeviceState.registerSource(
      paths,
      checkout,
      {
        id: "source",
        repository: "example/one",
        trackerKey: "#411",
        state: "open",
        registeredAt: "2026-11-21",
        endedAt: null,
        plan: JSON.stringify(plan),
      },
      [
        {
          sourceId: "source",
          key: "ticket",
          completion: "commit",
          kind: "commit-implementation",
          state: "ready",
        },
      ],
    ).tag,
  ).toBe("Ok");
  const runTool = ToolInvocation.run.bind(ToolInvocation);
  const transport = spyOn(ToolInvocation, "run").mockImplementation((input) => {
    const args = input.args ?? [];
    return runTool({
      ...input,
      args:
        input.tool === "git" && ["ls-remote", "fetch", "push"].includes(args[0] ?? "")
          ? args.map((arg) => (arg === "origin" ? origin : arg))
          : args,
    });
  });
  const input = { paths, cwd: worktree };
  const target = { sourceId: "source", assignment: "ticket" };
  async function launch(id: string, kind: "commit-implementation" | "commit-review") {
    const reserved = DeviceState.reserveLaunch(paths, checkout, "example/one", {
      id,
      ...target,
      state: "starting",
      name: id,
      resources: "worktree",
      branch: "ticket/411",
      host: "opencode",
      model: "test/model",
      requestedModel: "test/model",
      reasoningEffort: "medium",
      profile: null,
      release: '{"version":"3.0.0"}',
      skills: "[]",
      kind: JSON.stringify(WorkerKinds.resolve(kind)),
      herdrSocket: environment.HERDR_SOCKET_PATH,
      workspaceId: null,
      tabId: null,
      paneId: id,
      worktreePath: worktree,
      worktreeWorkspaceId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      failureReason: null,
      failureDetail: null,
      activity: null,
      activityAt: null,
    });
    expect(reserved.tag).toBe("Ok");
    expect(DeviceState.updateLaunch(paths, id, { state: "running" }).tag).toBe("Ok");
    environment.HERDR_PANE_ID = id;
  }

  await launch("implementer", "commit-implementation");
  const initialized = await CommitDelivery.initialize({
    ...input,
    ...target,
    repository: "example/one",
    ticket: "#411",
    checkout,
    checks,
  });
  expect(initialized.tag).toBe("Ok");
  async function change(text = "feature\n") {
    await Bun.write(`${worktree}/feature`, text);
    git(worktree, "add", ".");
    git(worktree, "commit", "-qm", "intermediate");
  }

  async function review() {
    const started = await CommitDelivery.review(input);
    expect(started.tag).toBe("Ok");
    expect(DeviceState.finishImplementer(paths, "implementer").tag).toBe("Ok");
    await launch("reviewer", "commit-review");
  }

  function data() {
    const read = DeviceState.readSources(paths, "example/one", "source");
    expect(read.tag).toBe("Ok");
    const row = read.getOr([]).at(0)?.commitDeliveries?.at(0);
    return {
      revision: z.number().parse(row?.revision),
      data: DeviceState.commitDeliverySchema().parse(JSON.parse(z.string().parse(row?.data))),
    };
  }

  return {
    root,
    paths,
    input,
    target,
    checkout,
    worktree,
    origin,
    base,
    git,
    change,
    review,
    data,
    transport,
    runTool,
    async dispose() {
      transport.mockRestore();
      await rm(root, { recursive: true, force: true });
    },
  };
}
