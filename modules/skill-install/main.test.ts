import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm, symlink } from "node:fs/promises";
import { SkillInstall } from "./main.ts";

const cliPath = new URL("../../cli.ts", import.meta.url).pathname;
const bundledSkillsRoot = new URL("../../skills/", import.meta.url).pathname;
const projectRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    projectRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function makeProject(): Promise<string> {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-install-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${root}`.quiet();
  projectRoots.push(root);
  return root;
}

async function runOperator(root: string, args: string[]) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function filesUnder(directory: string): Promise<string[]> {
  return (
    await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true }))
  ).toSorted();
}

describe("operator install", () => {
  test("refuses to guess a target", async () => {
    const root = await makeProject();

    const result = await runOperator(root, ["install", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "invalid",
      reason: "missing_target",
      operation: "install",
    });
    expect(await filesUnder(root)).toEqual([]);
  });

  test("copies every bundled skill asset into the OpenCode target", async () => {
    const root = await makeProject();

    const result = await runOperator(root, ["install", "--opencode", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "completed",
      reason: "skills_installed",
    });
    expect(await filesUnder(`${root}/.agents/skills/operator`)).toEqual(
      await filesUnder(`${bundledSkillsRoot}operator`),
    );
  });

  test("copies into both targets when both are selected", async () => {
    const root = await makeProject();

    const result = await runOperator(root, ["install", "--opencode", "--claude", "--json"]);

    expect(result.exitCode).toBe(0);
    const bundled = await filesUnder(`${bundledSkillsRoot}operator`);
    expect(await filesUnder(`${root}/.agents/skills/operator`)).toEqual(bundled);
    expect(await filesUnder(`${root}/.claude/skills/operator`)).toEqual(bundled);
  });

  test("adopts a matching copy without writing it again", async () => {
    const root = await makeProject();
    await runOperator(root, ["install", "--claude"]);
    const installedSkill = `${root}/.claude/skills/operator/SKILL.md`;
    const firstWrite = (await Bun.file(installedSkill).stat()).mtimeMs;

    const result = await runOperator(root, ["install", "--claude", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "completed",
      reason: "skills_already_installed",
    });
    expect((await Bun.file(installedSkill).stat()).mtimeMs).toBe(firstWrite);
  });

  test("preserves a changed copy and reports the conflicting path", async () => {
    const root = await makeProject();
    await runOperator(root, ["install", "--opencode", "--claude"]);
    const changedPath = `${root}/.claude/skills/operator/SKILL.md`;
    await Bun.write(changedPath, "# my own edit\n");

    const result = await runOperator(root, ["install", "--opencode", "--claude", "--json"]);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "conflict",
      reason: "skill_copy_conflict",
      blockers: [
        {
          reason: "skill_copy_modified",
          skill: "operator",
          target: "claude-code",
          paths: [".claude/skills/operator/SKILL.md"],
        },
      ],
    });
    expect(await Bun.file(changedPath).text()).toBe("# my own edit\n");
  });

  test("writes nothing to an unaffected target while a conflict stands", async () => {
    const root = await makeProject();
    await Bun.write(`${root}/.claude/skills/operator/SKILL.md`, "# my own edit\n");

    const result = await runOperator(root, ["install", "--opencode", "--claude", "--json"]);

    expect(result.exitCode).toBe(4);
    expect(await filesUnder(root)).toEqual([".claude/skills/operator/SKILL.md"]);
  });
});

describe("Operator release skill contents", () => {
  test("identifies the bundled skills with one stable content hash", async () => {
    const [first, second] = await Promise.all([SkillInstall.identity(), SkillInstall.identity()]);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});

const mattCommit = "b".repeat(40);
const reviewPath = "skills/eng/code-review/SKILL.md";
const reviewReference = "skills/eng/code-review/references/checklist.md";

function blobSha(text: string): string {
  return new Bun.CryptoHasher("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
}

function upstreamTree(files: Record<string, string>) {
  return {
    truncated: false,
    tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", sha: blobSha(text) })),
  };
}

const mattState: {
  commit: unknown;
  tree: unknown;
  served: Record<string, string>;
} = { commit: {}, tree: {}, served: {} };

function resetMatt(files: Record<string, string>) {
  mattState.commit = { sha: mattCommit };
  mattState.tree = upstreamTree(files);
  mattState.served = { ...files };
}

const mattFiles = { [reviewPath]: "# review\n", [reviewReference]: "check\n" };
let mattServer: ReturnType<typeof Bun.serve> | undefined;
const previousMattApi = process.env.OPERATOR_MATT_SKILLS_API;

beforeAll(() => {
  mattServer = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/repos/mattpocock/skills/commits/main") return Response.json(mattState.commit);
      if (path === `/repos/mattpocock/skills/git/trees/${mattCommit}`) {
        return Response.json(mattState.tree);
      }
      const file = mattState.served[path.slice(`/mattpocock/skills/${mattCommit}/`.length)];
      return file === undefined ? new Response("missing", { status: 404 }) : new Response(file);
    },
  });
  process.env.OPERATOR_MATT_SKILLS_API = mattServer.url.origin;
});

afterAll(() => {
  mattServer?.stop(true);
  if (previousMattApi === undefined) delete process.env.OPERATOR_MATT_SKILLS_API;
  else process.env.OPERATOR_MATT_SKILLS_API = previousMattApi;
});

async function mattInstall(root: string) {
  const plan = await SkillInstall.mattPlan({ projectRoot: root, targets: ["opencode"] });
  return SkillInstall.mattApply({
    projectRoot: root,
    targets: ["opencode"],
    commit: mattCommit,
    approvedPlanId: plan.planId,
  });
}

describe("Matt skills upstream", () => {
  test("installs a pinned skill and records it in the ledger", async () => {
    resetMatt(mattFiles);
    const root = await makeProject();

    const result = await mattInstall(root);

    expect(result.status).toBe("applied");
    expect(result.plan.changes).toEqual([
      expect.objectContaining({ skill: "code-review", kind: "install", removed: [] }),
    ]);
    expect(
      await Bun.file(`${root}/.agents/skills/code-review/references/checklist.md`).text(),
    ).toBe("check\n");
    expect(
      JSON.parse(await Bun.file(`${root}/.agents/skills/.operator-matt-skills.json`).text()),
    ).toMatchObject({ version: 1, skills: { "code-review": { path: "skills/eng/code-review" } } });
  });

  test("adopts a matching copy that has no ledger entry", async () => {
    resetMatt(mattFiles);
    const root = await makeProject();
    await Bun.write(`${root}/.agents/skills/code-review/SKILL.md`, "# review\n");
    await Bun.write(`${root}/.agents/skills/code-review/references/checklist.md`, "check\n");

    const plan = await SkillInstall.mattPlan({ projectRoot: root, targets: ["opencode"] });

    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toEqual([
      {
        skill: "code-review",
        target: "opencode",
        path: ".agents/skills/code-review",
        kind: "adopt",
        files: [],
        removed: [],
      },
    ]);
  });

  test("updates a recorded copy and removes the files that upstream removed", async () => {
    resetMatt(mattFiles);
    const root = await makeProject();
    await mattInstall(root);
    resetMatt({ [reviewPath]: "# review 2\n" });

    const result = await mattInstall(root);

    expect(result.status).toBe("applied");
    expect(result.plan.changes).toEqual([
      expect.objectContaining({
        kind: "update",
        removed: [".agents/skills/code-review/references/checklist.md"],
      }),
    ]);
    expect(
      await Bun.file(`${root}/.agents/skills/code-review/references/checklist.md`).exists(),
    ).toBe(false);
  });

  test("refuses an unrecorded copy that differs and writes nothing", async () => {
    resetMatt(mattFiles);
    const root = await makeProject();
    await Bun.write(`${root}/.agents/skills/code-review/SKILL.md`, "# mine\n");

    const result = await mattInstall(root);

    expect(result.status).toBe("conflict");
    expect(result.plan.conflicts).toEqual([
      {
        skill: "code-review",
        target: "opencode",
        paths: [
          ".agents/skills/code-review/SKILL.md",
          ".agents/skills/code-review/references/checklist.md",
        ],
      },
    ]);
    expect(await filesUnder(root)).toEqual([".agents/skills/code-review/SKILL.md"]);
  });

  test("refuses a recorded copy that was edited after the last write", async () => {
    resetMatt(mattFiles);
    const root = await makeProject();
    await mattInstall(root);
    await Bun.write(`${root}/.agents/skills/code-review/SKILL.md`, "# mine\n");
    resetMatt({ [reviewPath]: "# review 2\n" });

    const result = await mattInstall(root);

    expect(result.status).toBe("conflict");
    expect(await Bun.file(`${root}/.agents/skills/code-review/SKILL.md`).text()).toBe("# mine\n");
  });

  test("keeps the bytes of the ledger entries it does not change", async () => {
    resetMatt(mattFiles);
    const root = await makeProject();
    const ledgerPath = `${root}/.agents/skills/.operator-matt-skills.json`;
    const other = { hash: "c".repeat(64), note: "kept", path: "skills/eng/other" };
    await Bun.write(ledgerPath, `${JSON.stringify({ version: 1, skills: { other } }, null, 2)}\n`);

    await mattInstall(root);

    expect(await Bun.file(ledgerPath).text()).toBe(`{
  "version": 1,
  "skills": {
    "other": {
      "hash": "${"c".repeat(64)}",
      "note": "kept",
      "path": "skills/eng/other"
    },
    "code-review": {
      "path": "skills/eng/code-review",
      "hash": "58321ec2a9a30d038522a21c3e5daf4414fcad2a0d1482de93773c45732d3538"
    }
  }
}
`);
  });

  const refusals: Array<{
    name: string;
    arrange: (root: string) => Promise<void> | void;
    message: (root: string) => string;
    commit?: string;
    planOnly?: boolean;
  }> = [
    {
      name: "a commit response that is not an object",
      planOnly: true,
      arrange: () => {
        mattState.commit = [];
      },
      message: () => "Invalid Matt skills response or ledger",
    },
    {
      name: "a commit response with no SHA",
      planOnly: true,
      arrange: () => {
        mattState.commit = { sha: "main" };
      },
      message: () => "Invalid Matt skills commit or blob SHA",
    },
    {
      name: "a requested commit that is not a SHA",
      arrange: () => {},
      commit: "main",
      message: () => "Invalid Matt skills commit or blob SHA",
    },
    {
      name: "a tree response that is not an object",
      arrange: () => {
        mattState.tree = "tree";
      },
      message: () => "Invalid Matt skills response or ledger",
    },
    {
      name: "a truncated tree",
      arrange: () => {
        mattState.tree = { ...upstreamTree(mattFiles), truncated: true };
      },
      message: () => "Incomplete Matt skills tree",
    },
    {
      name: "a tree with no file list",
      arrange: () => {
        mattState.tree = { truncated: false, tree: {} };
      },
      message: () => "Incomplete Matt skills tree",
    },
    {
      name: "a tree file that is not an object",
      arrange: () => {
        mattState.tree = { truncated: false, tree: [...upstreamTree(mattFiles).tree, null] };
      },
      message: () => "Invalid Matt skills response or ledger",
    },
    {
      name: "a fetched file that does not match its Git blob",
      arrange: () => {
        mattState.served[reviewReference] = "changed\n";
      },
      message: () => `Matt skill blob changed: ${reviewReference}`,
    },
    {
      name: "two upstream skills with one name",
      arrange: () => resetMatt({ ...mattFiles, "skills/misc/code-review/SKILL.md": "# again\n" }),
      message: () => "Duplicate Matt skill name: code-review",
    },
    {
      name: "a roster without code-review",
      arrange: () => resetMatt({ "skills/eng/other/SKILL.md": "# other\n" }),
      message: () => "Matt code-review skill is missing from the roster",
    },
    {
      name: "a symbolic link at the host folder",
      arrange: async (root) => {
        await Bun.$`mkdir -p ${root}/elsewhere && ln -s ${root}/elsewhere ${root}/.agents`.quiet();
      },
      message: (root) => `Symbol link in skill path: ${root}/.agents`,
    },
    {
      name: "a symbolic link at the skills folder",
      arrange: async (root) => {
        await Bun.$`mkdir -p ${root}/elsewhere ${root}/.agents`.quiet();
        await symlink(`${root}/elsewhere`, `${root}/.agents/skills`);
      },
      message: (root) => `Symbol link in skill path: ${root}/.agents/skills`,
    },
    {
      name: "a symbolic link at the skill folder",
      arrange: async (root) => {
        await Bun.$`mkdir -p ${root}/elsewhere ${root}/.agents/skills`.quiet();
        await symlink(`${root}/elsewhere`, `${root}/.agents/skills/code-review`);
      },
      message: (root) => `Symbolic link in skill path: ${root}/.agents/skills/code-review`,
    },
    {
      name: "a symbolic link at the ledger",
      arrange: async (root) => {
        await Bun.write(`${root}/elsewhere.json`, '{"version":1,"skills":{}}');
        await Bun.$`mkdir -p ${root}/.agents/skills`.quiet();
        await symlink(
          `${root}/elsewhere.json`,
          `${root}/.agents/skills/.operator-matt-skills.json`,
        );
      },
      message: (root) =>
        `Symbolic link in Matt skills ledger: ${root}/.agents/skills/.operator-matt-skills.json`,
    },
    ...[
      ["a ledger that is not an object", [], "Invalid Matt skills response or ledger"],
      [
        "a ledger with no skill map",
        { version: 1, skills: [] },
        "Invalid Matt skills response or ledger",
      ],
      [
        "a ledger of an unknown version with no skill map",
        { version: 2 },
        "Invalid Matt skills response or ledger",
      ],
      [
        "a ledger of an unknown version",
        { version: 2, skills: {} },
        "Unsupported Matt skills ledger",
      ],
      [
        "a ledger entry that is not an object",
        { version: 1, skills: { other: "x" } },
        "Invalid Matt skills response or ledger",
      ],
      [
        "a ledger entry with no content hash",
        { version: 1, skills: { other: { path: "skills/eng/other", hash: "x" } } },
        "Invalid Matt skills ledger",
      ],
      [
        "a ledger entry whose content hash is a list",
        { version: 1, skills: { other: { path: "skills/eng/other", hash: ["c".repeat(64)] } } },
        "Invalid Matt skills ledger",
      ],
      [
        "a ledger entry with no path",
        { version: 1, skills: { other: { hash: "c".repeat(64) } } },
        "Invalid Matt skills ledger",
      ],
      [
        "a ledger whose first bad entry has bad fields",
        { version: 1, skills: { first: { path: 1 }, second: "x" } },
        "Invalid Matt skills ledger",
      ],
    ].map(([name, ledger, message]) => ({
      name: String(name),
      arrange: async (root: string) => {
        await Bun.write(
          `${root}/.agents/skills/.operator-matt-skills.json`,
          JSON.stringify(ledger),
        );
      },
      message: () => String(message),
    })),
  ];

  test.each(refusals)("refuses $name and writes nothing", async (refusal) => {
    resetMatt(mattFiles);
    const root = await makeProject();
    await refusal.arrange(root);
    const before = await filesUnder(root);

    const planning = SkillInstall.mattPlan({
      projectRoot: root,
      targets: ["opencode"],
      commit: refusal.commit,
    });
    await expect(planning).rejects.toThrow(new Error(refusal.message(root)));
    // Apply takes its commit from the approval, so it never reads the commit response.
    if (!refusal.planOnly) {
      const applying = SkillInstall.mattApply({
        projectRoot: root,
        targets: ["opencode"],
        commit: refusal.commit ?? mattCommit,
        approvedPlanId: "approved",
      });
      await expect(applying).rejects.toThrow(new Error(refusal.message(root)));
    }
    expect(await filesUnder(root)).toEqual(before);
  });
});
