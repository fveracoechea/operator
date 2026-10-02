import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { PullRequestStack } from "./main.ts";

const roots: string[] = [];
const realGit = Bun.which("git") ?? "git";
const inheritedPath = process.env.PATH ?? "";
const wrapper = `${Bun.env.TMPDIR ?? "/tmp"}/operator-stack-git-${crypto.randomUUID()}`;
const gitLog = `${wrapper}/calls.log`;

// Git runs through a wrapper that logs each call, so a test reads every option a push used.
beforeAll(async () => {
  await Bun.$`mkdir -p ${wrapper}/bin`.quiet();
  await Bun.write(
    `${wrapper}/bin/git`,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${gitLog}\nexec ${realGit} "$@"\n`,
  );
  await Bun.$`chmod +x ${wrapper}/bin/git`.quiet();
  process.env.PATH = `${wrapper}/bin:${inheritedPath}`;
});

afterAll(async () => {
  process.env.PATH = inheritedPath;
  await rm(wrapper, { force: true, recursive: true });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  await rm(gitLog, { force: true });
});

/** A project with two commits and a bare remote that holds only its first one. */
async function project() {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-stack-${crypto.randomUUID()}`;
  roots.push(root);
  const repo = `${root}/repo`;
  const remote = `${root}/remote.git`;
  const commit = (message: string) =>
    Bun.$`${realGit} -C ${repo} -c user.email=t@example.com -c user.name=Test commit --allow-empty -q -m ${message}`.quiet();
  await Bun.$`${realGit} init -q -b main ${repo}`.quiet();
  await Bun.$`${realGit} init -q --bare ${remote}`.quiet();
  await commit("first");
  await Bun.$`${realGit} -C ${repo} remote add origin ${remote}`.quiet();
  await Bun.$`${realGit} -C ${repo} push -q origin main`.quiet();
  const first = (await Bun.$`${realGit} -C ${repo} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();
  await commit("second");
  const second = (await Bun.$`${realGit} -C ${repo} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();
  return { repo, remote, first, second };
}

async function remoteRefs(remote: string): Promise<string> {
  return (
    await Bun.$`${realGit} -C ${remote} for-each-ref --format=${"%(refname) %(objectname)"}`.quiet()
  ).stdout
    .toString()
    .trim();
}

async function pushCalls(): Promise<string[]> {
  const file = Bun.file(gitLog);
  const text = (await file.exists()) ? await file.text() : "";
  return text.split("\n").filter((line) => / push( |$)/.test(` ${line}`));
}

describe("the push of a stack publication", () => {
  test("pushes every new name at once with no force option, and a repeat writes nothing", async () => {
    const { repo, remote, second } = await project();
    const effect = {
      kind: "push" as const,
      remote: "origin",
      refs: [{ name: "operator/source/1/1", commit: second }],
    };

    const pushed = await PullRequestStack.write({ repoRoot: repo, effect });
    expect(pushed).toEqual({ status: "done", how: "written", number: null, url: null });
    expect(await remoteRefs(remote)).toContain(`refs/heads/operator/source/1/1 ${second}`);

    const repeated = await PullRequestStack.write({ repoRoot: repo, effect });
    expect(repeated).toEqual({ status: "done", how: "observed", number: null, url: null });

    const calls = await pushCalls();
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call).toContain("--atomic");
      expect(call).not.toMatch(
        /--force|--force-with-lease|--force-if-includes|--delete|--mirror|--prune|(^| )-f( |$)|(^| )\+/,
      );
    }
  });

  test("a name the remote already holds at another commit is a conflict, never pushed over", async () => {
    const { repo, remote, first, second } = await project();
    await Bun.$`${realGit} -C ${repo} push -q origin ${first}:refs/heads/operator/source/1/1`.quiet();
    const before = await remoteRefs(remote);

    const outcome = await PullRequestStack.write({
      repoRoot: repo,
      effect: {
        kind: "push",
        remote: "origin",
        refs: [{ name: "operator/source/1/1", commit: second }],
      },
    });

    // The commit there is an ancestor, so a plain push would move the name. The read refuses it.
    expect(outcome).toEqual({
      status: "conflict",
      found: `operator/source/1/1 at ${first}`,
    });
    expect(await remoteRefs(remote)).toBe(before);
    expect(await pushCalls()).toEqual([]);
  });

  test("a half push is recovered as a conflict for a person, not pushed again", async () => {
    const { repo, remote, second } = await project();
    await Bun.$`${realGit} -C ${repo} push -q origin ${second}:refs/heads/operator/source/1/1`.quiet();
    const before = await remoteRefs(remote);

    const outcome = await PullRequestStack.write({
      repoRoot: repo,
      effect: {
        kind: "push",
        remote: "origin",
        refs: [
          { name: "operator/source/1/1", commit: second },
          { name: "operator/source/1/2", commit: second },
        ],
      },
    });

    expect(outcome.status).toBe("conflict");
    expect(await remoteRefs(remote)).toBe(before);
    expect(await pushCalls()).toEqual([]);
  });

  test("a push the remote rejects lands nothing and records the message of the remote", async () => {
    const { repo, remote, second } = await project();
    await Bun.write(
      `${remote}/hooks/pre-receive`,
      "#!/bin/sh\necho 'signed commits are required' >&2\nexit 1\n",
    );
    await Bun.$`chmod +x ${remote}/hooks/pre-receive`.quiet();

    const outcome = await PullRequestStack.write({
      repoRoot: repo,
      effect: {
        kind: "push",
        remote: "origin",
        refs: [{ name: "operator/source/1/1", commit: second }],
      },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" ? outcome.message : "").toContain(
      "signed commits are required",
    );
    expect(await remoteRefs(remote)).not.toContain("operator/source");
  });
});
