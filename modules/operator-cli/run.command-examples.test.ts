import { afterAll, beforeAll, expect, test } from "bun:test";
import { Environment } from "../environment/main.ts";
// Bun has no temporary directory or recursive directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerTestDevice } from "../../scripts/device-fixture.ts";

const repository = new URL("../../", import.meta.url).pathname;
const cli = path.join(repository, "cli.ts");
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

/** Every command that a next action, a refusal, or a brief names in source text. */
function sourceMentions(text: string) {
  return [...text.matchAll(/(?<![\w@/.-])operator ((?:--)?[a-z][a-z-]*(?: \S+)?)/g)]
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
  expect(commands.has("review slack-done")).toBe(true);
  expect(commands.has("install")).toBe(true);
  expect(commands.has("install matt")).toBe(true);
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

test("next actions, refusals, and briefs name only implemented commands", async () => {
  expect(await scan(["cli.ts", "modules/**/*.ts"], sourceMentions, true)).toEqual([]);
});
