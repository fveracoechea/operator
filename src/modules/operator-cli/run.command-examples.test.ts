import { afterAll, beforeAll, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no temporary directory or recursive directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerTestDevice } from "../../../tools/device-fixture.ts";
import { UpstreamSkills } from "../upstream-skills/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { writeGuideSkills } from "./command-fixture.ts";

const repository = new URL("../../../", import.meta.url).pathname;
const cli = path.join(repository, "src/cli.ts");
const word = /^[a-z][a-z-]*$/;
let root = "";
let usage = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "operator-command-examples-"));
  await registerTestDevice(root);
  const child = Bun.spawn([process.execPath, cli, "--help"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Environment.child(),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  usage = output;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The command names of one help line, for example `review add` and `review post`. */
function helpCommands(line: string) {
  const [group = "", ...rest] = line
    .trim()
    .replace(/^Usage: /, "")
    .split(/\s+/)
    .slice(1);
  if (group.startsWith("--"))
    return [group, ...rest].filter((token) => /^--[a-z]+$/.test(token) && token !== "--json");
  const names = [];
  for (let index = 0; word.test(rest[index] ?? ""); index += 2) {
    names.push(rest[index]);
    if (rest[index + 1] !== "|") break;
  }
  return names.length === 0 ? [group] : names.map((name) => `${group} ${name}`);
}

function implemented() {
  const commands = new Set(
    usage
      .split("\n")
      .filter((line) => /^(Usage: )?\s*operator /.test(line))
      .flatMap(helpCommands),
  );
  const grouped = new Set(
    [...commands].filter((one) => one.includes(" ")).map((one) => one.split(" ")[0]),
  );
  return { commands, grouped };
}

/**
 * A mention names an implemented command when its group and its subcommand both exist. Prose in
 * source text can follow a command without subcommands, for example "Read operator next later".
 * A code example cannot.
 */
function known(mention: string, help: ReturnType<typeof implemented>, prose = false) {
  const [group = "", next = ""] = mention
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9-]+$/, ""));
  if (help.commands.has(`${group} ${next}`)) return true;
  const strict = !prose || help.grouped.has(group);
  return help.commands.has(group) && !(strict && word.test(next));
}

/** Command examples in code spans and in shell fence lines that start with the command. */
function markdownMentions(text: string) {
  const mentions = [...text.matchAll(/`(?:operator|bun cli\.ts) ([^`]+)`/g)].map((m) => m[1] ?? "");
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*```(\S*)/.exec(line);
    if (marker) fence = fence === null ? (marker[1] ?? "") : null;
    const command = /^\s*(?:operator|bun cli\.ts) (.+)$/.exec(line);
    if (["sh", "bash", "shell", ""].includes(fence ?? "none") && command)
      mentions.push(command[1] ?? "");
  }
  return mentions;
}

/**
 * Every command that a next action, a refusal, or a brief names in source text. A mention ends at
 * a backslash, because a string escape such as the newline in the usage text is not part of it.
 */
function sourceMentions(text: string) {
  return [...text.matchAll(/(?<![\w@/.-])operator ((?:--)?[a-z][a-z-]*(?: [^\s\\]+)?)/g)]
    .map((m) => m[1] ?? "")
    .filter((mention) => !mention.startsWith("command"));
}

async function scan(patterns: string[], mentions: (text: string) => string[], prose = false) {
  const help = implemented();
  const unknown = [];
  for (const pattern of patterns)
    for await (const file of new Bun.Glob(pattern).scan({ cwd: repository })) {
      // The changelog records released history, and test files name removed commands on purpose.
      if (/^CHANGELOG\.md$|\.test\.ts$|fixture|\/fake-/.test(file)) continue;
      for (const mention of mentions(await Bun.file(path.join(repository, file)).text()))
        if (!known(mention, help, prose)) unknown.push(`${file}: operator ${mention}`);
    }
  return unknown;
}

test("help lists the commands that the guard reads", () => {
  const { commands } = implemented();
  expect(commands.has("review add")).toBe(true);
  expect(commands.has("install")).toBe(true);
  expect(commands.has("install matt")).toBe(false);
  expect(commands.has("--version")).toBe(true);
  expect(commands.has("next")).toBe(true);
  expect(commands.has("crew next")).toBe(false);
});

test("the guard refuses removed and invented commands", () => {
  const help = implemented();
  for (const mention of [
    "crew next",
    "review report",
    "install latest",
    "install matt",
    "cleanup remove",
    "next later",
  ])
    expect(known(mention, help)).toBe(false);
  for (const mention of ["next --source id", "next.", "install --claude", "--help", "ready"])
    expect(known(mention, help)).toBe(true);
  for (const mention of ["work frontier", "pr close", "install latest"])
    expect(known(mention, help, true)).toBe(false);
  for (const mention of ["cleanup with", "next later", "review next."])
    expect(known(mention, help, true)).toBe(true);
});

test("documented command examples name only implemented commands", async () => {
  expect(
    await scan(["*.md", "docs/**/*.md", "skills/**/*.md", "agents/**/*.md"], markdownMentions),
  ).toEqual([]);
});

test.each([
  ["dispatch", "--adopt"],
  ["pr ready", "--note"],
  ["pr wait", "--note"],
  ["pr merge", "--source"],
  ["pr merge", "--assignment"],
])("help supports the role guide's %s %s example", (command, flag) => {
  expect(
    usage
      .split("\n")
      .some((line) => line.trim().startsWith(`operator ${command} `) && line.includes(`${flag} `)),
  ).toBe(true);
});

test.each(["opencode", "claude-code"] as const)(
  "every skill named by a bundled kind guide resolves in the %s fixture",
  async (host) => {
    const paths = OperatorHome.resolve(
      Environment.parse({ HOME: `${root}/guides-${host}`, NODE_ENV: "test" }),
    );
    await writeGuideSkills(paths.upstreamSkills[host], paths.skillHosts[host]);
    await Bun.write(`${paths.upstreamSkills[host]}/code-review/SKILL.md`, "# Fixture review\n", {
      createPath: true,
    });
    await Bun.write(`${paths.skillHosts[host]}/no-slop/SKILL.md`, "# Fixture no-slop\n", {
      createPath: true,
    });
    await Bun.write(
      `${paths.skillHosts[host]}/show-me/SKILL.md`,
      "# Fixture visual explanation\n",
      { createPath: true },
    );
    expect(await UpstreamSkills.checkGuides(paths, host)).toMatchObject({
      tag: "Ok",
      value: { blockers: [], warnings: [] },
    });
    await rm(`${paths.upstreamSkills[host]}/tdd/SKILL.md`);
    expect(await UpstreamSkills.checkGuides(paths, host)).toMatchObject({
      tag: "Ok",
      value: {
        blockers: [{ guide: "worker-agent/kinds/implementation.md", skill: "tdd" }],
        warnings: [],
      },
    });
    await writeGuideSkills(paths.upstreamSkills[host], paths.skillHosts[host]);
    await rm(`${paths.skillHosts[host]}/handoff/SKILL.md`);
    const missingNote = await UpstreamSkills.checkGuides(paths, host);
    expect(missingNote.tag).toBe("Ok");
    if (missingNote.tag === "Ok") {
      expect(missingNote.value.blockers.map(({ guide, skill }) => ({ guide, skill }))).toEqual(
        ["research", "prototype", "review", "pr-feedback"].map((kind) => ({
          guide: `worker-agent/kinds/${kind}.md`,
          skill: "handoff",
        })),
      );
    }
    await writeGuideSkills(paths.upstreamSkills[host], paths.skillHosts[host]);
    await rm(`${paths.skillHosts[host]}/show-me/SKILL.md`);
    expect(await UpstreamSkills.checkGuides(paths, host)).toMatchObject({
      tag: "Ok",
      value: {
        blockers: [],
        warnings: [{ guide: "worker-agent/kinds/answer.md", skill: "show-me" }],
      },
    });
  },
);

test("bundled skills stay within their word ceilings", async () => {
  const supervisorFiles = (
    await Array.fromAsync(new Bun.Glob("skills/super-agent/**/*.md").scan({ cwd: repository }))
  ).toSorted();
  expect(supervisorFiles).toEqual(
    ["SKILL.md", "plans.md", "setup.md"].map((file) => `skills/super-agent/${file}`),
  );
  let supervisorWords = 0;
  for (const file of supervisorFiles)
    supervisorWords +=
      (await Bun.file(path.join(repository, file)).text()).match(/\S+/g)?.length ?? 0;
  expect(supervisorWords).toBeLessThanOrEqual(700);

  const workerFiles = (
    await Array.fromAsync(new Bun.Glob("skills/worker-agent/**/*.md").scan({ cwd: repository }))
  ).toSorted();
  expect(workerFiles).toEqual(
    [
      "SKILL.md",
      "kinds/answer.md",
      "kinds/commit-implementation.md",
      "kinds/commit-review.md",
      "kinds/implementation.md",
      "kinds/pr-feedback.md",
      "kinds/prototype.md",
      "kinds/research.md",
      "kinds/review.md",
      "managed-stacks.md",
    ].map((file) => `skills/worker-agent/${file}`),
  );
  for (const file of workerFiles) {
    const words = (await Bun.file(path.join(repository, file)).text()).match(/\S+/g)?.length ?? 0;
    const ceiling = file.endsWith("/SKILL.md")
      ? 250
      : file.endsWith("/managed-stacks.md")
        ? 300
        : 100;
    expect(words, file).toBeLessThanOrEqual(ceiling);
  }
});

test("next actions, refusals, and briefs name only implemented commands", async () => {
  expect(await scan(["src/cli.ts", "src/modules/**/*.ts"], sourceMentions, true)).toEqual([]);
});

test("bundled skills use result next steps and retain their authority limits", async () => {
  const worker = await Bun.file(path.join(repository, "skills/worker-agent/SKILL.md")).text();
  expect(worker).toContain("Follow each result's `next`");
  expect(worker).toContain("use only `gh stack view --json`");
  expect(worker).toContain(
    "When a skill says to ask the user, ask your SuperAgent with `operator question ask` and wait.",
  );
  expect(worker).toContain("Native subagents stay within your assignment and responsibility");
  expect(worker).toContain("Only answers labeled person are human answers");
  const implementation = await Bun.file(
    path.join(repository, "skills/worker-agent/kinds/implementation.md"),
  ).text();
  expect(implementation).toContain("stop once it succeeds");
  expect(implementation).toContain("Send no implementer note to review.");
  const guides = await OwnedSkills.guides();
  expect(guides).toHaveLength(8);
  for (const { guide, text } of guides) {
    expect(text, guide).not.toContain(".json>");
    expect(text, guide).not.toContain("router's");
  }
  const review = guides.find(({ guide }) => guide.endsWith("/review.md"))?.text ?? "";
  expect(review).toContain("without an implementer note");
  expect(review).toContain("`operator pr ready --file <ready.md> --note <note.md>`");
  const feedback = guides.find(({ guide }) => guide.endsWith("/pr-feedback.md"))?.text ?? "";
  expect(feedback).toContain("reviewer's note as open points, not evidence");
  expect(feedback).toContain("`operator pr wait --note <note.md>`");
  expect(feedback).toContain("unless checks run on your pushed head");
  expect(feedback).toContain("honor supervisor holds");
  expect(
    await Bun.file(path.join(repository, "skills/slack-pr-review-workflow/SKILL.md")).exists(),
  ).toBe(false);
  const supervisor = await Bun.file(path.join(repository, "skills/super-agent/SKILL.md")).text();
  expect(supervisor).toContain("`operator review skip <pr-url>` needs the person's instruction.");
  expect(supervisor).toContain("Operator schedules no Slack reads.");
  expect(supervisor).toContain("3 read-only calls per question");
  expect(supervisor).toContain("counting reads, searches, and status calls together");
  expect(supervisor).toContain("never a native subagent");
  expect(supervisor).toContain(
    "`operator next --wait --timeout 3600` in the host's background mode",
  );
  expect(supervisor).toContain("Only the person authorizes deletion of unlanded work");
  expect(supervisor).not.toContain("slack-drop");
  expect(supervisor).not.toContain("## Refusals");
  const plans = await Bun.file(path.join(repository, "skills/super-agent/plans.md")).text();
  expect(plans).toContain(
    "Assignment's own closed PR: `operator abandon`; it deletes no worktree or branch.",
  );
  expect(plans).toContain("Follow `clean_up` with `pr_closed` to abandon without a person stop.");
  expect(plans).toContain(
    "Ask about missing PR worktrees or parents closed/merged outside the default branch.",
  );
  expect(plans).toContain(
    "Only the person authorizes `cleanup --person-instructed` for unlanded work.",
  );
  expect(plans).toContain("resource mismatches");
  expect(plans).toContain("Write only the Task as spec plus authority");
  expect(plans).toContain("another author's PR uses review requests, never adoption");
  expect(plans).toContain(
    "On the person's instruction, merge parked work through `operator pr merge --source <id> --assignment <key>`",
  );
  expect(plans).toContain(
    "retains the worktree, and leaves dependencies unchanged until verified merge",
  );
  for (const text of [worker, supervisor, plans, ...guides.map(({ text }) => text)]) {
    expect(text).not.toContain("operator review wait");
    expect(text).not.toContain("operator handoff");
    expect(text).not.toContain("## Refusals");
  }
  const draft = await Bun.file(path.join(repository, "skills/pr-review/draft.md")).text();
  expect(draft).toContain("An approval waits until every required check has finished.");
  expect(draft).not.toContain("review_ci_pending");
});
