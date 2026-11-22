import { afterEach, expect, spyOn, test, mock } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
// Bun has no temporary-directory location API.
import { tmpdir } from "node:os";
import { PrStacks } from "./main.ts";
import { GithubApi } from "../github-api/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Err, Ok } from "unthrown";

let root: string | undefined;
afterEach(async () => {
  mock.restore();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("independent prerequisites produce a deterministic dependency-only base with leased publication", async () => {
  root = await mkdtemp(`${tmpdir()}/pr-stacks-`);
  const cwd = root;
  async function git(...args: string[]) {
    const answer = await ToolInvocation.run({ tool: "git", cwd, args, timeoutMs: 10000 });
    expect(answer.status).toBe("completed");
    if (answer.status !== "completed") return "";
    expect(answer.exitCode, answer.stderr).toBe(0);
    return answer.stdout.trim();
  }

  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.com");
  await git("commit", "--allow-empty", "-qm", "root");
  const remote = `${cwd}/remote.git`;
  await git("init", "--bare", "-q", remote);
  await git("remote", "add", "origin", remote);
  const heads = new Map<number, string>();
  for (const [name, number] of [
    ["a", 1],
    ["b", 2],
  ] as const) {
    await git("switch", "-qc", name, "main");
    await Bun.write(`${cwd}/${name}`, `${name}\n`);
    await git("add", name);
    await git("commit", "-qm", name);
    heads.set(number, await git("rev-parse", "HEAD"));
    await git("push", "-qu", "origin", name);
  }
  spyOn(GithubApi, "call").mockImplementation(async ({ args }) => {
    const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
    return {
      status: "succeeded",
      value: {
        httpStatus: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                baseRefName: "main",
                headRefName: number === 1 ? "a" : "b",
                headRefOid: heads.get(number),
                headRepository: { nameWithOwner: "example/one" },
              },
            },
          },
        },
      },
    };
  });
  const parents = [
    { assignment: "a", number: 1, branch: "a" },
    { assignment: "b", number: 2, branch: "b" },
  ];
  const input = {
    cwd,
    repository: "example/one",
    remote: "origin",
    namespace: "source/child",
    parents,
  };
  const prepared = await PrStacks.prepare(input);
  expect(prepared.tag).toBe("Ok");
  if (prepared.tag !== "Ok") return;
  const base = prepared.value;
  expect(base.managed).toBe(true);
  expect(base.branch).toStartWith("operator/stacks/source/child/");
  expect(await git("ls-tree", "--name-only", base.head)).toBe("a\nb");
  expect(await git("rev-parse", "HEAD")).toEqual(heads.get(2) ?? "");
  expect(await PrStacks.prepare({ ...input, parents: parents.toReversed() })).toEqual(prepared);
  expect(await PrStacks.start(input)).toMatchObject({
    tag: "Ok",
    value: { head: base.head, branch: base.branch, remote: "origin" },
  });
  expect(await git("ls-remote", "origin", `refs/heads/${base.branch}`)).toBe("");
  let intents = 0;
  const denied = {
    reason: "stack_parent",
    detail: "Controlled persistence failure.",
    next: { command: "operator next", why: "Inspect durable intent first." },
  };
  expect(
    await PrStacks.publish({
      cwd,
      remote: "origin",
      base,
      attempted: false,
      beforePush: () => {
        intents++;
        return Err(denied);
      },
    }),
  ).toMatchObject({ tag: "Err", error: denied });
  expect(intents).toBe(1);
  expect(await git("ls-remote", "origin", `refs/heads/${base.branch}`)).toBe("");
  expect(
    await PrStacks.publish({
      cwd,
      remote: "origin",
      base,
      attempted: true,
      beforePush: () => {
        intents++;
        return Ok(undefined);
      },
    }),
  ).toMatchObject({ tag: "Err" });
  expect(intents).toBe(1);
  expect(await git("ls-remote", "origin", `refs/heads/${base.branch}`)).toBe("");
  expect(
    (
      await PrStacks.publish({
        cwd,
        remote: "origin",
        base,
        attempted: false,
        beforePush: () => Ok(undefined),
      })
    ).tag,
  ).toBe("Ok");
  expect(
    (
      await PrStacks.publish({
        cwd,
        remote: "origin",
        base,
        attempted: true,
        beforePush: () => Ok(undefined),
      })
    ).tag,
  ).toBe("Ok");
  expect(await git("ls-remote", "origin", `refs/heads/${base.branch}`)).toStartWith(base.head);
  expect(PrStacks.decode(JSON.stringify(base))).toEqual(base);
  expect(
    (
      await PrStacks.publish({
        cwd,
        remote: "origin",
        base: { ...base, branch: "a" },
        attempted: false,
        beforePush: () => Ok(undefined),
      })
    ).tag,
  ).toBe("Err");
  const single = await PrStacks.prepare({
    ...input,
    parents: [{ assignment: "a", number: 1, branch: "a" }],
  });
  expect(single).toMatchObject({
    tag: "Ok",
    value: { managed: false, branch: "a", head: heads.get(1) },
  });
  heads.set(1, "a".repeat(40));
  expect((await PrStacks.prepare(input)).tag).toBe("Err");
});
