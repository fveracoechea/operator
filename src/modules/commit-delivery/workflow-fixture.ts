import { expect, spyOn } from "bun:test";
import { Ok, OkAsync } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { Projects } from "../projects/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
import { Workflow } from "./workflow.ts";

type Invocation = Awaited<ReturnType<typeof ToolInvocation.run>>;
type ToolInput = Parameters<typeof ToolInvocation.run>[0];
type Source = Extract<ReturnType<typeof DeviceState.readSources>, { tag: "Ok" }>["value"][number];
type Pane = Extract<ReturnType<typeof DeviceState.readReport>, { tag: "Ok" }>["value"];
type Tree = { head: string; headTree: string; index: string; worktree: string; others: string };

export async function workflowSeed() {
  const fixture = await commitFixture();
  const environment = Environment.read();
  const pane = DeviceState.readReport(fixture.paths, {
    by: "pane",
    socket: environment.HERDR_SOCKET_PATH ?? "",
    paneId: "implementer",
  }).getOrElse(() => expect.unreachable("Seed pane must exist."));
  const source =
    DeviceState.readSources(fixture.paths, "example/one", "source").getOrElse(() =>
      expect.unreachable("Seed source must exist."),
    )[0] ?? expect.unreachable();
  return { fixture, environment, pane, source };
}

function completed(stdout = "", exitCode = 0): Invocation {
  return { status: "completed", exitCode, stdout, stderr: "" };
}

/** Public collaborator adapters exercise protocol decisions without re-provisioning Git/SQLite per case. */
export function workflowFixture(seed: Awaited<ReturnType<typeof workflowSeed>>) {
  const { fixture } = seed;
  const source: Source = structuredClone(seed.source);
  const pane: Pane = structuredClone(seed.pane);
  const environment = structuredClone(seed.environment);
  const baseTree = "d".repeat(40);
  const ticketTree = "c".repeat(40);
  const candidateHead = "b".repeat(40);
  const policy = {
    checks: [["git", "diff", "--exit-code"]],
    review: "required",
    publication: "local-and-origin",
  };
  const state = {
    source,
    pane,
    local: fixture.base,
    remote: fixture.base,
    fetchUrl: "https://github.com/example/one.git",
    pushUrl: "https://github.com/example/one.git",
    toplevel: fixture.worktree,
    localRef: "refs/heads/main",
    worktrees: "",
    common: new Map<string, string>(),
    contains: false,
    parent: fixture.base,
    message: "Ticket #411\n\nOperator-Ticket: source/ticket",
    intercept: undefined as
      | ((input: ToolInput) => Invocation | Promise<Invocation | undefined> | undefined)
      | undefined,
    writes: [] as Parameters<typeof DeviceState.changeCommitDelivery>[2][],
    trees: new Map<string, Tree>(),
  };
  state.trees.set(fixture.checkout, {
    head: fixture.base,
    headTree: baseTree,
    index: baseTree,
    worktree: baseTree,
    others: "",
  });
  state.trees.set(fixture.worktree, {
    head: "e".repeat(40),
    headTree: ticketTree,
    index: ticketTree,
    worktree: ticketTree,
    others: "",
  });
  function data() {
    const row =
      source.commitDeliveries?.find((row) => row.assignment === "ticket") ?? expect.unreachable();
    return DeviceState.commitDeliverySchema().parse(JSON.parse(row.data));
  }
  function replace(next: ReturnType<typeof data>) {
    const row =
      source.commitDeliveries?.find((row) => row.assignment === "ticket") ?? expect.unreachable();
    row.data = JSON.stringify(next);
  }
  function tree(cwd: string) {
    return state.trees.get(cwd) ?? expect.unreachable(`Missing fake checkout ${cwd}`);
  }
  function candidate() {
    return data().candidate ?? expect.unreachable("No recorded candidate.");
  }
  spyOn(Environment, "read").mockReturnValue(environment);
  spyOn(DeviceState, "readReport").mockImplementation(() => Ok(pane));
  spyOn(DeviceState, "readSources").mockImplementation(() => Ok([source]));
  spyOn(Projects, "githubRemote").mockReturnValue(OkAsync("origin"));
  const write = spyOn(DeviceState, "changeCommitDelivery").mockImplementation(
    (_paths, _target, change) => {
      state.writes.push(structuredClone(change));
      const next = DeviceState.commitDeliverySchema().parse(JSON.parse(change.data));
      let row = source.commitDeliveries?.find((row) => row.assignment === "ticket");
      if (row === undefined) {
        row = { ...fixture.target, revision: 0, data: change.data };
        source.commitDeliveries = [...(source.commitDeliveries ?? []), row];
      }
      row.data = JSON.stringify(next);
      row.revision++;
      return Ok(row.revision);
    },
  );
  const commands: Record<
    string,
    (args: string[], cwd: string) => Invocation | Promise<Invocation>
  > = {
    status(_args, cwd) {
      const current = state.trees.get(cwd);
      return completed(
        current !== undefined &&
          (current.index !== current.headTree ||
            current.worktree !== current.index ||
            current.others !== "")
          ? " M feature\n"
          : "",
      );
    },
    remote(args) {
      return completed(args.includes("--push") ? state.pushUrl : state.fetchUrl);
    },
    "ls-remote"() {
      return completed(`${state.remote}\trefs/heads/main\n`);
    },
    "rev-parse"(args, cwd) {
      if (args.includes("--show-toplevel"))
        return completed(cwd === fixture.checkout ? fixture.checkout : state.toplevel);
      if (args.includes("--git-common-dir"))
        return completed(state.common.get(cwd) ?? `${fixture.checkout}/.git`);
      if (args.includes("--git-path"))
        return completed(`${fixture.root}/missing-markers/${args.at(-1)}`);
      if (args.includes("HEAD^{tree}")) return completed(tree(cwd).headTree);
      if (args.includes(`${fixture.base}^{tree}`)) return completed(baseTree);
      if (args.includes("refs/heads/main")) return completed(state.local);
      if (args.includes("HEAD")) return completed(tree(cwd).head);
      return expect.unreachable(`Unexpected rev-parse ${args.join(" ")}`);
    },
    async worktree(args) {
      if (args[1] === "list")
        return completed(
          state.worktrees ||
            `worktree ${fixture.checkout}\nHEAD ${state.local}\nbranch refs/heads/main\n`,
        );
      if (args[1] === "add") {
        const path = args[4] ?? expect.unreachable();
        state.trees.set(path, {
          head: fixture.base,
          headTree: baseTree,
          index: baseTree,
          worktree: baseTree,
          others: "",
        });
        await Bun.write(`${path}/.git`, "fixture-owned candidate\n");
        return completed();
      }
      return expect.unreachable(`Unexpected worktree ${args.join(" ")}`);
    },
    diff(args, cwd) {
      if (args.includes("--binary")) return completed("independent fixture binary patch\n");
      if (args.includes("--name-only"))
        return completed(tree(cwd).worktree === args[2] ? "" : "feature\n");
      return completed();
    },
    "write-tree"(_args, cwd) {
      return completed(tree(cwd).index);
    },
    "ls-files"(_args, cwd) {
      return completed(tree(cwd).others);
    },
    apply(_args, cwd) {
      const current = tree(cwd);
      current.index = candidate().tree;
      current.worktree = candidate().tree;
      return completed();
    },
    commit(_args, cwd) {
      const current = tree(cwd);
      current.head = candidateHead;
      current.headTree = current.index;
      return completed();
    },
    show(_args, cwd) {
      return completed(
        `${tree(cwd).head}\n${state.parent}\n${tree(cwd).headTree}\n${state.message}\n`,
      );
    },
    "symbolic-ref"() {
      return completed(state.localRef);
    },
    "update-ref"(args) {
      if (args.at(-1) !== state.local) return completed("", 1);
      state.local = args.at(-2) ?? expect.unreachable();
      tree(fixture.checkout).head = state.local;
      tree(fixture.checkout).headTree = ticketTree;
      return completed();
    },
    fetch() {
      return completed();
    },
    "merge-base"() {
      return completed("", state.contains ? 0 : 1);
    },
    push() {
      state.remote = candidate().head ?? expect.unreachable();
      return completed();
    },
  };
  const tools = spyOn(ToolInvocation, "run").mockImplementation(async (input) => {
    const special = await state.intercept?.(input);
    if (special !== undefined) return special;
    if (input.tool !== "git") return completed();
    const command =
      commands[input.args[0] ?? ""] ?? expect.unreachable(`Unexpected Git ${input.args.join(" ")}`);
    return command(input.args, input.cwd ?? fixture.worktree);
  });
  tools.mockClear();
  async function review() {
    expect((await Workflow.review(fixture.input)).tag).toBe("Ok");
    const launch = pane.launch ?? expect.unreachable();
    launch.id = "reviewer";
    launch.kind = JSON.stringify(WorkerKinds.resolve("commit-review"));
    environment.HERDR_PANE_ID = "reviewer";
  }
  async function ready() {
    await review();
    expect((await Workflow.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  }
  const initial = data();
  expect(initial).toMatchObject({
    repository: "example/one",
    ticket: "#411",
    checkout: fixture.checkout,
    base: fixture.base,
    policy,
    candidate: null,
    history: [],
    stage: "build",
    journal: [],
  });
  return {
    ...fixture,
    ...state,
    state,
    data,
    replace,
    tree,
    candidate,
    tools,
    write,
    review,
    ready,
    completed,
    candidateHead,
    ticketTree,
    baseTree,
    source,
    pane,
    environment,
    delivery: { ...fixture.input, text: "## Dispositions" },
  };
}
