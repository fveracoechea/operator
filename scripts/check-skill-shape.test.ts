import { afterAll, expect, test } from "bun:test";
// Bun has no temporary directory API and no recursive remove.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { join } = path;

const scriptPath = new URL("./check-skill-shape.ts", import.meta.url).pathname;
const workspace = await mkdtemp(join(tmpdir(), "check-skill-shape-"));

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

function router(frontmatter: string[], body: string[] = []): string {
  return ["---", ...frontmatter, "---", "", "# Sample", ...body, ""].join("\n");
}

const validFrontmatter = ["name: sample", "description: Use when the sample fires."];

function descriptionLine(length: number): string {
  return `description: ${"a".repeat(length)}`;
}

async function checkSkills(files: Record<string, string>) {
  const skillsRoot = join(workspace, crypto.randomUUID());
  await Promise.all(
    Object.entries(files).map(([path, contents]) => Bun.write(join(skillsRoot, path), contents)),
  );

  const child = Bun.spawn(["bun", scriptPath, "."], {
    cwd: skillsRoot,
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

test("accepts a router whose name is its directory", async () => {
  expect(await checkSkills({ "sample/SKILL.md": router(validFrontmatter) })).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "",
  });
});

test("refuses a frontmatter name that is not the directory name", async () => {
  const frontmatter = ["name: other", "description: Use when the sample fires."];
  expect(await checkSkills({ "sample/SKILL.md": router(frontmatter) })).toEqual({
    exitCode: 1,
    stderr: 'sample/SKILL.md: frontmatter name "other" must be the directory name "sample"\n',
    stdout: "",
  });
});

test("refuses a frontmatter field outside the portable floor", async () => {
  const frontmatter = [...validFrontmatter, "allowed-tools: Read"];
  expect(await checkSkills({ "sample/SKILL.md": router(frontmatter) })).toEqual({
    exitCode: 1,
    stderr: 'sample/SKILL.md: frontmatter field "allowed-tools" is outside the portable floor\n',
    stdout: "",
  });
});

test("accepts a user-invoked router", async () => {
  const frontmatter = [...validFrontmatter, "disable-model-invocation: true"];
  expect(await checkSkills({ "sample/SKILL.md": router(frontmatter) })).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "",
  });
});

test("refuses a router over 150 lines", async () => {
  const body = Array.from({ length: 145 }, (_, index) => `Line ${index + 1}.`);
  expect(await checkSkills({ "sample/SKILL.md": router(validFrontmatter, body) })).toEqual({
    exitCode: 1,
    stderr: "sample/SKILL.md: a router is 150 lines at most, and this is 151\n",
    stdout: "",
  });
});

test("accepts skill descriptions that total 2200 characters", async () => {
  expect(
    await checkSkills({
      "first/SKILL.md": router(["name: first", descriptionLine(1100)]),
      "second/SKILL.md": router(["name: second", descriptionLine(1100)]),
    }),
  ).toEqual({ exitCode: 0, stderr: "", stdout: "" });
});

test("refuses skill descriptions that total over 2200 characters", async () => {
  expect(
    await checkSkills({
      "first/SKILL.md": router(["name: first", descriptionLine(1100)]),
      "second/SKILL.md": router(["name: second", descriptionLine(1101)]),
    }),
  ).toEqual({
    exitCode: 1,
    stderr: ".: skill descriptions total 2200 characters at most, and these total 2201\n",
    stdout: "",
  });
});

test("refuses a topic file no link reaches", async () => {
  expect(
    await checkSkills({
      "sample/SKILL.md": router(validFrontmatter),
      "sample/TOPIC.md": "# Topic\n",
    }),
  ).toEqual({
    exitCode: 1,
    stderr: "sample/TOPIC.md: no link in SKILL.md reaches this file\n",
    stdout: "",
  });
});

test("accepts a topic file the router links", async () => {
  expect(
    await checkSkills({
      "sample/SKILL.md": router(validFrontmatter, ["", "Read [TOPIC.md](TOPIC.md) first."]),
      "sample/TOPIC.md": "# Topic\n",
    }),
  ).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "",
  });
});

test("refuses frontmatter it cannot read", async () => {
  expect(await checkSkills({ "sample/SKILL.md": "# Sample\n" })).toEqual({
    exitCode: 1,
    stderr: "sample/SKILL.md: requires a readable frontmatter block delimited by ---\n",
    stdout: "",
  });
});

const workerFrontmatter = ["name: worker-agent", "description: Use when a SuperAgent delegates."];

test("refuses a worker instruction that messages its SuperAgent, in the router or a topic", async () => {
  expect(
    await checkSkills({
      "worker-agent/SKILL.md": router(workerFrontmatter, [
        "Then tell your SuperAgent through Herdr that the report is submitted.",
        "Read [TOPIC.md](TOPIC.md) for PRs.",
      ]),
      "worker-agent/TOPIC.md": "# Topic\n\nStop and tell your SuperAgent.\n",
    }),
  ).toEqual({
    exitCode: 1,
    stderr: [
      "worker-agent/SKILL.md:7: a worker reaches its SuperAgent only through recorded state, not a message",
      "worker-agent/TOPIC.md:3: a worker reaches its SuperAgent only through recorded state, not a message",
      "",
    ].join("\n"),
    stdout: "",
  });
});

test("accepts a worker instruction that uses recorded state, and other skills that name Herdr", async () => {
  expect(
    await checkSkills({
      "worker-agent/SKILL.md": router(workerFrontmatter, [
        "Record a question for your supervising SuperAgent with `operator question ask`.",
      ]),
      "super-agent/SKILL.md": router(
        ["name: super-agent", "description: Use when supervising."],
        ["Tell the SuperAgent next door through Herdr."],
      ),
    }),
  ).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "",
  });
});
