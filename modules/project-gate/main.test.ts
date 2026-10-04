import { afterEach, describe, expect, test } from "bun:test";
// Bun has no temporary directory API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gateDeclarationSchema } from "./declaration.ts";
import { ProjectGate } from "./main.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/project-gate-`);
  roots.push(root);
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.email", "gate@example.test");
  await git(root, "config", "user.name", "Gate Test");
  await git(root, "config", "commit.gpgsign", "false");
  return root;
}

async function commit(root: string, declaration: unknown): Promise<string> {
  await Bun.write(
    `${root}/operator-gate.json`,
    typeof declaration === "string" ? declaration : JSON.stringify(declaration),
  );
  await git(root, "add", "operator-gate.json");
  await git(root, "commit", "--quiet", "-m", "gate");
  return git(root, "rev-parse", "HEAD");
}

const VALID = {
  $schema: "./node_modules/@fveracoechea/operator/gate.schema.json",
  commands: [
    { name: "install", argv: ["bun", "install", "--frozen-lockfile"], timeoutSeconds: 300 },
    { name: "quality", argv: ["bun", "run", "quality"], timeoutSeconds: 1800 },
  ],
};

test("the gate is read at the named commit, and an uncommitted edit has no effect", async () => {
  const root = await repository();
  const first = await commit(root, VALID);
  await Bun.write(
    `${root}/operator-gate.json`,
    JSON.stringify({ ...VALID, commands: [VALID.commands[0]] }),
  );

  const read = await ProjectGate.read({ repository: root, commit: "HEAD" });

  expect(read).toEqual({
    status: "declared",
    commit: first,
    path: "operator-gate.json",
    identity: expect.any(String),
    commands: VALID.commands,
  });
});

test("an older commit keeps its own gate after a later commit changes the file", async () => {
  const root = await repository();
  const first = await commit(root, VALID);
  await commit(root, { ...VALID, commands: [VALID.commands[1]] });

  const read = await ProjectGate.read({ repository: root, commit: first });

  expect(read.status === "declared" ? read.commands.map((one) => one.name) : read).toEqual([
    "install",
    "quality",
  ]);
});

test("a commit with no declaration reads as missing", async () => {
  const root = await repository();
  await Bun.write(`${root}/README.md`, "project\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "--quiet", "-m", "readme");
  const head = await git(root, "rev-parse", "HEAD");

  expect(await ProjectGate.read({ repository: root, commit: "HEAD" })).toEqual({
    status: "missing",
    commit: head,
    path: "operator-gate.json",
  });
});

test.each([
  [
    "a duplicate name",
    { ...VALID, commands: [VALID.commands[0], { ...VALID.commands[1], name: "install" }] },
    "commands.1.name: the name install is already used by an earlier command",
  ],
  [
    "a missing time limit",
    { ...VALID, commands: [{ name: "install", argv: ["bun", "install"] }] },
    "commands.0.timeoutSeconds",
  ],
  [
    "a shell string",
    { ...VALID, commands: [{ name: "q", argv: "bun run quality", timeoutSeconds: 60 }] },
    "commands.0.argv",
  ],
  ["a missing schema", { commands: VALID.commands }, "$schema"],
  ["no command", { ...VALID, commands: [] }, "commands"],
  ["text that is not JSON", "{ not json", "the file is not JSON"],
])("%s is refused with the field that is wrong", async (_name, declaration, field) => {
  const root = await repository();
  await commit(root, declaration);

  const read = await ProjectGate.read({ repository: root, commit: "HEAD" });

  expect(read.status).toBe("invalid");
  expect(read.status === "invalid" ? read.issues.join("\n") : "").toContain(field);
});

test("a commit that Git cannot name is unread, never missing", async () => {
  const root = await repository();
  await commit(root, VALID);

  const read = await ProjectGate.read({ repository: root, commit: "0".repeat(40) });

  expect(read.status).toBe("unread");
});

describe("each place states a gate read in its own words", () => {
  const path = "operator-gate.json";
  const commit = "abc123";
  const missing = { status: "missing" as const, commit, path };
  const invalid = { status: "invalid" as const, commit, path, issues: ["one", "two"] };
  const unread = { status: "unread" as const, commit, path, detail: "git failed." };

  test.each([
    ["submit", missing, "operator-gate.json at abc123 is missing."],
    ["submit", invalid, "operator-gate.json at abc123 is invalid: one; two."],
    ["submit", unread, "operator-gate.json at abc123 is unread: git failed.."],
    ["dispatch", missing, "Commit abc123 holds no operator-gate.json."],
    ["dispatch", invalid, "operator-gate.json at abc123 is not valid: one; two."],
    ["dispatch", unread, "operator-gate.json could not be read at abc123: git failed."],
    [
      "readiness",
      missing,
      "The commit abc123 at HEAD holds no operator-gate.json, so no code result can show that it passed the project gate.",
    ],
    ["readiness", invalid, "operator-gate.json at abc123 is not a valid project gate: one; two."],
    ["readiness", unread, "operator-gate.json could not be read at HEAD: git failed."],
  ] as const)("%s, %o", (place, read, text) => {
    expect(ProjectGate.describe(read, place)).toBe(text);
  });

  test("a declared gate names its commands at every place", () => {
    const declared = {
      status: "declared" as const,
      commit,
      path,
      identity: "id",
      commands: [
        { name: "lint", argv: ["bun", "run", "lint"], timeoutSeconds: 60 },
        { name: "test", argv: ["bun", "test"], timeoutSeconds: 600 },
      ],
    };
    for (const place of ["submit", "dispatch", "readiness"] as const) {
      expect(ProjectGate.describe(declared, place)).toBe(
        "operator-gate.json at abc123 declares lint, test.",
      );
    }
  });
});

test("the generated schema requires a name, the arguments, and a time limit", () => {
  const schema: unknown = JSON.parse(ProjectGate.jsonSchemaText());
  expect(schema).toMatchObject({
    required: ["$schema", "commands"],
    properties: {
      commands: { items: { required: ["name", "argv", "timeoutSeconds"] } },
    },
  });
});

test("a command line quotes each argument that a shell would split", () => {
  expect(ProjectGate.commandLine(["bun", "run", "quality"])).toBe("bun run quality");
  expect(ProjectGate.commandLine(["sh", "-c", "echo it's"])).toBe(`sh -c 'echo it'\\''s'`);
});

test("this repository declares a valid gate that installs, then runs the quality gate", async () => {
  const declared = gateDeclarationSchema.parse(
    await Bun.file(new URL("../../operator-gate.json", import.meta.url)).json(),
  );
  expect(declared.commands.map((one) => one.argv.join(" "))).toEqual([
    "bun install --frozen-lockfile",
    "bun run quality",
  ]);
});
