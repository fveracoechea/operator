import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, chmod, symlink, or recursive removal API.
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, Ok } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { UpstreamSkills } from "./main.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "upstream-skills-api-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function paths() {
  return OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
}

test("presence follows independently revised links without an Operator content ledger", async () => {
  const input = paths();
  expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({
    tag: "Ok",
    value: [`${root}/.agents/skills/code-review/SKILL.md`],
  });
  await Bun.write(`${root}/shared/SKILL.md`, "independent upstream revision\n", {
    createPath: true,
  });
  await Bun.write(`${root}/.agents/skills/placeholder`, "", { createPath: true });
  await symlink(`${root}/shared`, `${root}/.agents/skills/code-review`);
  expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({ tag: "Ok", value: [] });
  await Bun.write(`${root}/shared/SKILL.md`, " \n");
  expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({
    tag: "Ok",
    value: [`${root}/.agents/skills/code-review/SKILL.md`],
  });
});

test("unexpected programming defects remain defects", async () => {
  const spy = spyOn(ToolInvocation, "run").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the public external-tool boundary.
    throw new TypeError("programming defect");
  });
  try {
    const result = await UpstreamSkills.install(["claude-code"], paths());
    expect(result.tag).toBe("Defect");
    if (result.tag === "Defect") expect(result.cause).toBeInstanceOf(TypeError);
  } finally {
    spy.mockRestore();
  }
});

const commit = "0123456789abcdef0123456789abcdef01234567";
const policy =
  "The upstream installer owns replacement and its lock. It can replace local edits without an Operator preview. Inspect a failed or interrupted install before trying again.";
type Answer = Awaited<ReturnType<typeof ToolInvocation.run>>;
function done(stdout: string): Answer {
  return { status: "completed", exitCode: 0, stdout, stderr: "" };
}

// An unfinished answer is refused even when it carries an exit code.
const unfinished = { status: "no-answer" as const, detail: "interrupted", exitCode: 0 };

// Each upstream repository, by the clone URL, and the skill folders that its fixture holds.
const fixtures: Record<string, string[]> = {
  // Only the productivity and engineering folders count, so a skill elsewhere, and the invalid
  // frontmatter of an in-progress skill, never reach the roster.
  "https://github.com/mattpocock/skills.git": [
    "skills/engineering/code-review",
    "skills/engineering/bun",
    "skills/productivity/tdd",
    "skills/misc/setup-pre-commit",
    "skills/in-progress/software-factory",
    "skills/productivity-notes/drafts",
  ],
  "https://github.com/cursor/plugins.git": [
    "pstack/skills/unslop",
    "harness/pstack/claude-code/skills/unslop",
    "pstack/skills/swarm",
  ],
  "https://github.com/humanlayer/skills.git": [
    "plugins/show-me/skills/show-me",
    "plugins/rpi/skills/rpi",
  ],
};

/** Writes the fixture skill folders into one clone destination. */
async function writeClone(args: string[], extra: string[]) {
  for (const folder of [...(fixtures[String(args.at(-2))] ?? []), ...extra])
    await Bun.write(
      `${args.at(-1)}/${folder}/SKILL.md`,
      folder.includes("in-progress")
        ? "---\nname: [unclosed\n---\n"
        : `---\nname: ${folder.split("/").at(-1)}\n---\n`,
      { createPath: true },
    );
}

/** Confirms every selected skill, as a complete installer answer does. */
function confirmAll(args: string[]) {
  const names = args.slice(args.indexOf("--skill") + 1, -2);
  return done(JSON.stringify(names.map((name) => ({ name, status: "installed" }))));
}

/** Answers each source in order. A given answer applies only to the source or installer at `at`. */
function upstream(answers: {
  clone?: Answer;
  revision?: Answer;
  installer?: Answer;
  at?: number;
  extra?: string;
}) {
  const calls: Parameters<typeof ToolInvocation.run>[0][] = [];
  const at = answers.at ?? 0;
  const extra = answers.extra === undefined ? [] : [`skills/engineering/${answers.extra}`];
  let clones = 0;
  let installs = 0;
  const spy = spyOn(ToolInvocation, "run").mockImplementation(async (input) => {
    calls.push(input);
    if (input.args[0] === "clone") {
      await writeClone(input.args, clones === 0 ? extra : []);
      return clones++ === at ? (answers.clone ?? done("")) : done("");
    }
    if (input.tool === "git")
      return (clones - 1 === at ? answers.revision : undefined) ?? done(`${commit}\n`);
    return (installs++ === at ? answers.installer : undefined) ?? confirmAll(input.args);
  });
  return { calls, spy };
}

function resolution(directory: string, repository: string) {
  return [
    {
      tool: "git",
      args: [
        "clone",
        "--depth",
        "1",
        "--",
        `https://github.com/${repository}.git`,
        `${directory}/${repository}`,
      ],
      cwd: directory,
      timeoutMs: 60000,
    },
    {
      tool: "git",
      args: ["rev-parse", "HEAD"],
      cwd: `${directory}/${repository}`,
      timeoutMs: 10000,
    },
  ];
}

function installer(directory: string, source: string, skills: string[]) {
  return {
    tool: "bun",
    args: [
      "x",
      "--bun",
      "skills@1.7.4",
      "add",
      source,
      "--global",
      "--agent",
      "opencode",
      "claude-code",
      "--skill",
      ...skills,
      "--yes",
      "--json",
    ],
    cwd: directory,
    timeoutMs: 120000,
  };
}

test("installs every source at its resolved commit with a positive roster and removes the clones", async () => {
  const { calls, spy } = upstream({});
  try {
    expect(await UpstreamSkills.install(["opencode", "claude-code"], paths())).toEqual(
      Ok({
        reason: "upstream_installed",
        data: {
          installerVersion: "1.7.4",
          hosts: ["opencode", "claude-code"],
          sources: [
            { repository: "mattpocock/skills", commit, skills: ["code-review", "tdd"] },
            { repository: "cursor/plugins", commit, skills: ["unslop"] },
            { repository: "humanlayer/skills", commit, skills: ["show-me"] },
          ],
          replacementPolicy: policy,
        },
      }),
    );
    const directory = calls[0]?.cwd ?? "";
    expect(directory.startsWith(path.join(tmpdir(), "operator-upstream-"))).toBe(true);
    expect(calls).toEqual([
      ...resolution(directory, "mattpocock/skills"),
      ...resolution(directory, "cursor/plugins"),
      ...resolution(directory, "humanlayer/skills"),
      installer(directory, `mattpocock/skills#${commit}`, ["code-review", "tdd"]),
      installer(
        directory,
        `https://github.com/cursor/plugins/tree/${commit}/pstack/skills/unslop`,
        ["unslop"],
      ),
      installer(
        directory,
        `https://github.com/humanlayer/skills/tree/${commit}/plugins/show-me/skills/show-me`,
        ["show-me"],
      ),
    ]);
    expect(
      await Bun.file(`${directory}/mattpocock/skills/skills/productivity/tdd/SKILL.md`).exists(),
    ).toBe(false);
    expect(UpstreamSkills.replacementPolicy()).toBe(policy);
  } finally {
    spy.mockRestore();
  }
});

test.each([
  [
    "clone unavailable",
    { clone: { status: "unavailable", tool: "git", detail: "absent" } },
    "Cannot read the current revision of mattpocock/skills. No installer was invoked.",
    1,
  ],
  [
    "clone failed",
    { clone: { status: "completed", exitCode: 128, stdout: "", stderr: "denied" }, at: 1 },
    "Cannot read the current revision of cursor/plugins. No installer was invoked.",
    3,
  ],
  [
    "clone unfinished",
    { clone: unfinished, at: 2 },
    "Cannot read the current revision of humanlayer/skills. No installer was invoked.",
    5,
  ],
  [
    "revision unfinished",
    { revision: unfinished },
    "Cannot resolve a full commit of mattpocock/skills. No installer was invoked.",
    2,
  ],
  [
    "revision unavailable",
    { revision: { status: "no-answer", detail: "interrupted" }, at: 1 },
    "Cannot resolve a full commit of cursor/plugins. No installer was invoked.",
    4,
  ],
  [
    "revision failed",
    { revision: { status: "completed", exitCode: 1, stdout: commit, stderr: "" }, at: 2 },
    "Cannot resolve a full commit of humanlayer/skills. No installer was invoked.",
    6,
  ],
] as const)("a %s resolution stops before any installer", async (_name, answers, detail, count) => {
  const { calls, spy } = upstream(answers);
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
      Err({ reason: "upstream_resolution_failed", detail }),
    );
    expect(calls).toHaveLength(count);
  } finally {
    spy.mockRestore();
  }
});

test.each([
  [
    { status: "unavailable", tool: "bun", detail: "bun is not on the path." },
    0,
    { reason: "upstream_installer_unavailable", detail: "bun is not on the path." },
  ],
  [
    { status: "no-answer", detail: "bun x ended on SIGTERM." },
    1,
    {
      reason: "upstream_install_unconfirmed",
      detail: `cursor/plugins: bun x ended on SIGTERM. ${policy}`,
    },
  ],
  [
    { status: "completed", exitCode: 1, stdout: "", stderr: "lock held" },
    2,
    { reason: "upstream_install_failed", detail: `humanlayer/skills: lock held ${policy}` },
  ],
  [
    done('[{"name":"code-review","status":"installed"}]'),
    0,
    {
      reason: "upstream_install_unconfirmed",
      detail: `mattpocock/skills: The installer did not confirm every selected skill. ${policy}`,
    },
  ],
] as const)(
  "an installer answer %j is a refusal that stops later sources",
  async (installer, at, error) => {
    const { calls, spy } = upstream({ installer, at });
    try {
      expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(Err(error));
      expect(calls.filter((call) => call.tool === "bun")).toHaveLength(at + 1);
    } finally {
      spy.mockRestore();
    }
  },
);

test("an invalid commit, an empty owned catalog, an owned-only roster, or a repeated name is an invalid catalog", async () => {
  const { calls, spy } = upstream({ revision: done("main") });
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toMatchObject({
      tag: "Err",
      error: { reason: "upstream_catalog_invalid" },
    });
    expect(calls).toHaveLength(2);
    spy.mockRestore();
    const invalid = Err({
      reason: "upstream_catalog_invalid" as const,
      detail:
        "A complete owned catalog and a nonempty roster for each upstream source are required. No installer was invoked.",
    });
    const owned = spyOn(OwnedSkills, "names").mockResolvedValue([]);
    const empty = upstream({});
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(invalid);
    expect(empty.calls).toHaveLength(6);
    owned.mockResolvedValue(["code-review", "bun", "tdd"]);
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(invalid);
    owned.mockResolvedValue(["show-me"]);
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(invalid);
    expect(empty.calls.filter((call) => call.tool === "bun")).toEqual([]);
    mock.restore();
    const repeated = upstream({ extra: "unslop" });
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
      Err({
        reason: "upstream_catalog_invalid",
        detail: "More than one upstream source selects unslop. No installer was invoked.",
      }),
    );
    expect(repeated.calls.filter((call) => call.tool === "bun")).toEqual([]);
  } finally {
    mock.restore();
  }
});

test("a pinned folder that the upstream repository moved is an invalid catalog", async () => {
  const moved = fixtures["https://github.com/humanlayer/skills.git"];
  fixtures["https://github.com/humanlayer/skills.git"] = ["skills/show-me"];
  const { calls, spy } = upstream({});
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
      Err({
        reason: "upstream_catalog_invalid",
        detail:
          "humanlayer/skills has no skill at plugins/show-me/skills/show-me. No installer was invoked.",
      }),
    );
    expect(calls.filter((call) => call.tool === "bun")).toEqual([]);
  } finally {
    fixtures["https://github.com/humanlayer/skills.git"] = moved ?? [];
    spy.mockRestore();
  }
});

test("an interrupted or failed installer is not silently retried or called complete", async () => {
  for (const [installer, reason] of [
    [{ status: "no-answer", detail: "interrupted" }, "upstream_install_unconfirmed"],
    [{ status: "completed", exitCode: 1, stdout: "", stderr: "failed" }, "upstream_install_failed"],
  ] as const) {
    const { calls, spy } = upstream({ installer });
    try {
      expect(await UpstreamSkills.install(["opencode"], paths())).toMatchObject({
        tag: "Err",
        error: { reason },
      });
      expect(calls.map((call) => call.tool)).toEqual([
        "git",
        "git",
        "git",
        "git",
        "git",
        "git",
        "bun",
      ]);
    } finally {
      spy.mockRestore();
    }
  }
});
test.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "ELOOP"])(
  "a %s failure is an upstream I/O refusal",
  async (code) => {
    const spy = spyOn(ToolInvocation, "run").mockRejectedValue(
      Object.assign(new Error("io"), { code }),
    );
    try {
      expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
        Err({ reason: "upstream_io_failed", detail: "Error: io" }),
      );
    } finally {
      spy.mockRestore();
    }
  },
);

test("a syntax error is an invalid catalog and other failures stay defects", async () => {
  const spy = spyOn(ToolInvocation, "run").mockRejectedValue(new SyntaxError("bad"));
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
      Err({ reason: "upstream_catalog_invalid", detail: "SyntaxError: bad" }),
    );
    for (const cause of [Object.assign(new Error("reset"), { code: "ECONNRESET" }), null]) {
      spy.mockRejectedValue(cause);
      expect(await UpstreamSkills.install(["opencode"], paths())).toMatchObject({
        tag: "Defect",
        cause,
      });
    }
  } finally {
    spy.mockRestore();
  }
});

test.skipIf(asRoot)(
  "presence counts directories, file parents, and loops as missing and stops on other errors",
  async () => {
    const input = paths();
    const skills = `${root}/.agents/skills`;
    const missing = Ok([`${skills}/code-review/SKILL.md`]);
    await Bun.write(`${skills}/code-review/SKILL.md/inner`, "", { createPath: true });
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(missing);
    await rm(`${skills}/code-review`, { recursive: true });
    await Bun.write(`${skills}/code-review`, "a file\n");
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(missing);
    await rm(`${skills}/code-review`);
    await symlink(`${skills}/code-review`, `${skills}/code-review`);
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(missing);
    await rm(`${skills}/code-review`);
    await Bun.write(`${skills}/code-review/SKILL.md`, "present\n", { createPath: true });
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(Ok([]));
    await chmod(`${skills}/code-review`, 0o000);
    try {
      expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({
        tag: "Err",
        error: { reason: "upstream_io_failed" },
      });
    } finally {
      await chmod(`${skills}/code-review`, 0o755);
    }
    expect(await UpstreamSkills.check(input, "claude-code")).toEqual(
      Ok([`${root}/.claude/skills/code-review/SKILL.md`]),
    );
  },
);

test("presence checks refuse a host root outside the temporary test root", async () => {
  const input = paths();
  const outside = {
    ...input,
    upstreamSkills: { ...input.upstreamSkills, opencode: "/operator-absent-host/skills" },
  };
  expect(await UpstreamSkills.check(outside, "opencode")).toMatchObject({ tag: "Defect" });
});
