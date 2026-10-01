import type { FakeIssue, GithubFakeState } from "./github-fake-state.ts";
import { runJson, type Workspace } from "./workspace-fixture.ts";

/**
 * Registers work the way a session does: the structure lives on the GitHub fake, the input holds
 * only the execution fields, and the CLI previews the plan and then registers that revision.
 *
 * A test states its source in one shape, close to what it means: a parent issue and its items.
 * This fixture writes the issues, the sub-issue order, and the blocking links to the fake, so a
 * test cannot describe a structure the tracker would not hold.
 */

export const SOURCE_REPOSITORY = "fveracoechea/operator";

export type FixtureKind = "specification" | "ticket" | "wayfinder";

export type FixtureItem = {
  /** A name the test uses for the item. The CLI names it by its issue key. */
  key: string;
  /** The issue number. A fixture picks one when the test does not care. */
  issue?: number;
  repository?: string;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  /** The planning boundary a specification or ticket item states in the input. */
  kind?: "production" | "planning";
  /** The type label of a wayfinder item. */
  wayfinderType?: string;
  /** The items this one is blocked by, by the key the test gave them. */
  dependsOn?: Array<{ key: string; sourceId?: string }>;
  acceptanceRequirements?: string[];
  permissions?: { writePaths: string[]; allowedCommands: string[]; network: boolean };
  fixedInputs?: unknown[];
  /** False when the input leaves the item out. */
  inInput?: boolean;
};

export type FixtureSource = {
  sourceKind: FixtureKind;
  /** The parent issue number. A ticket is its own item, so its item takes this number. */
  parent: number;
  repository?: string;
  title?: string;
  body?: string;
  items: FixtureItem[];
};

/** What a fixture needs to reach the fake and the CLI of one test. */
export type FixtureTarget = {
  root: string;
  github: string;
  run: (args: string[]) => Promise<{ exitCode: number; stdout: string; json: any }>;
};

const FIXTURE_KEYS = "fixture-keys.json";

export function issueKey(number: number, repository = SOURCE_REPOSITORY): string {
  return `${repository.toLowerCase()}#${number}`;
}

/** The database id the fake gives one issue. It stays the same for one number and repository. */
function databaseId(repository: string, number: number): number {
  let hash = 7;
  for (const character of repository.toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000;
  }
  return hash * 100_000 + number;
}

export function fakeIssue(options: {
  number: number;
  repository?: string;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
}): FakeIssue {
  const repository = options.repository ?? SOURCE_REPOSITORY;
  const closed = options.state === "closed";
  return {
    id: databaseId(repository, options.number),
    repository_url: `https://api.github.com/repos/${repository}`,
    labels: (options.labels ?? []).map((name) => ({ name })),
    number: options.number,
    state: closed ? "closed" : "open",
    state_reason: closed ? "completed" : null,
    closed_by: closed ? { login: "someone" } : null,
    closed_at: closed ? "2026-09-01T00:00:00Z" : null,
    updated_at: "2026-09-01T00:00:00Z",
    title: options.title ?? `Issue ${options.number}`,
    body: options.body ?? `The body of issue ${options.number}.`,
  };
}

export async function readFake(github: string): Promise<GithubFakeState> {
  const file = Bun.file(`${github}/state.json`);
  return (await file.exists())
    ? file.json()
    : {
        viewer: "operator-bot",
        nextCommentId: 1,
        issues: {},
        comments: {},
        events: {},
        subIssues: {},
        blockedBy: {},
      };
}

export async function writeFake(github: string, state: GithubFakeState): Promise<void> {
  await Bun.write(`${github}/state.json`, `${JSON.stringify(state, null, 2)}\n`);
}

/** The issue number of each item a test named, across every source of one fake. */
async function readKeys(github: string): Promise<Record<string, number>> {
  const file = Bun.file(`${github}/${FIXTURE_KEYS}`);
  return (await file.exists()) ? file.json() : {};
}

function fixtureKey(parent: number, key: string): string {
  return `${parent}|${key}`;
}

function itemNumber(source: FixtureSource, item: FixtureItem, index: number): number {
  if (source.sourceKind === "ticket") {
    return source.parent;
  }
  return item.issue ?? source.parent * 100 + index + 1;
}

/** The parent number a cross-source dependency names, read from its `#<number>` suffix. */
function parentOf(sourceId: string): number {
  return Number(/#(\d+)$/.exec(sourceId)?.[1] ?? "0");
}

/**
 * Writes the parent, its items in order, and each blocking link to the fake. An issue the fake
 * already holds keeps its title and body, so a tracker fixture keeps the text it asserts on.
 */
export async function seedSource(
  github: string,
  source: FixtureSource,
): Promise<Map<string, number>> {
  const state = await readFake(github);
  const keys = await readKeys(github);
  const repository = source.repository ?? SOURCE_REPOSITORY;
  const numbers = new Map<string, number>();
  source.items.forEach((item, index) => {
    const number = itemNumber(source, item, index);
    numbers.set(item.key, number);
    keys[fixtureKey(source.parent, item.key)] = number;
  });

  // A ticket is its own item, so the item below writes its text.
  const held = state.issues[String(source.parent)];
  state.issues[String(source.parent)] = fakeIssue({
    number: source.parent,
    repository,
    title: held?.title ?? source.title,
    body: held?.body ?? source.body,
  });

  const items = source.items.map((item) => {
    const number = numbers.get(item.key) ?? 0;
    const issue = fakeIssue({
      number,
      repository: item.repository ?? repository,
      title: item.title ?? `Item ${item.key}`,
      body: item.body ?? `The approved scope of item ${item.key}.`,
      state: item.state,
      labels: item.wayfinderType === undefined ? [] : [`wayfinder:${item.wayfinderType}`],
    });
    return issue;
  });
  for (const issue of items) {
    state.issues[String(issue.number)] = issue;
  }
  if (source.sourceKind !== "ticket") {
    state.subIssues = { ...state.subIssues, [String(source.parent)]: items };
  }

  for (const item of source.items) {
    const number = numbers.get(item.key) ?? 0;
    state.blockedBy = {
      ...state.blockedBy,
      [String(number)]: (item.dependsOn ?? []).map((dependency) => {
        const parent =
          dependency.sourceId === undefined ? source.parent : parentOf(dependency.sourceId);
        const blocker = keys[fixtureKey(parent, dependency.key)];
        const issue = blocker === undefined ? undefined : state.issues[String(blocker)];
        if (issue === undefined) {
          throw new Error(`the fixture names ${dependency.key}, which no seeded source holds`);
        }
        return issue;
      }),
    };
  }

  await writeFake(github, state);
  await Bun.write(`${github}/${FIXTURE_KEYS}`, JSON.stringify(keys));
  return numbers;
}

/** The Operator input of one source: only the execution fields, keyed by issue. */
export function sourceInput(source: FixtureSource, numbers: Map<string, number>) {
  const repository = source.repository ?? SOURCE_REPOSITORY;
  return {
    sourceKind: source.sourceKind,
    source: issueKey(source.parent, repository),
    items: source.items
      .filter((item) => item.inInput !== false && item.state !== "closed")
      .map((item) => ({
        issue: issueKey(numbers.get(item.key) ?? 0, item.repository ?? repository),
        ...(source.sourceKind === "wayfinder"
          ? item.kind === undefined
            ? {}
            : { kind: item.kind }
          : { kind: item.kind ?? "production" }),
        acceptanceRequirements: item.acceptanceRequirements ?? ["The quality gate passes."],
        // Each item writes its own folder, so the frontier hold never orders them.
        permissions: item.permissions ?? {
          writePaths: [`modules/${item.key}/`],
          allowedCommands: ["bun test"],
          network: false,
        },
        fixedInputs: item.fixedInputs ?? [],
      })),
  };
}

export async function writeInput(root: string, value: unknown): Promise<string> {
  const path = `${root}/work-input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

export async function planSource(target: FixtureTarget, inputPath: string) {
  return target.run(["work", "register", "--plan", "--input", inputPath]);
}

/**
 * Seeds one source, previews it, and registers the plan revision the preview gave.
 * `keys` maps each item key the test gave to its assignment.
 */
export async function registerSource(
  target: FixtureTarget,
  ownerToken: string,
  source: FixtureSource,
) {
  const numbers = await seedSource(target.github, source);
  const inputPath = await writeInput(target.root, sourceInput(source, numbers));
  const plan = await planSource(target, inputPath);
  const registered = await target.run([
    "work",
    "register",
    "--request",
    crypto.randomUUID(),
    "--owner-token",
    ownerToken,
    "--input",
    inputPath,
    "--plan-revision",
    String(plan.json.data?.planRevision ?? "none"),
  ]);
  // The reads of a registration are setup, so a test of a later step sees only its own calls.
  await Bun.write(`${target.github}/calls.log`, "");
  const byIssue = new Map<string, string>(
    (registered.json.data?.registered ?? []).map(
      (one: { sourceKey: string; assignmentId: string }) => [one.sourceKey, one.assignmentId],
    ),
  );
  const keys = new Map<string, string>();
  for (const item of source.items) {
    const assignment = byIssue.get(
      issueKey(numbers.get(item.key) ?? 0, item.repository ?? source.repository),
    );
    if (assignment !== undefined) {
      keys.set(item.key, assignment);
    }
  }
  return { ...registered, plan, keys, numbers, inputPath };
}

/** The source id the CLI records for one fixture source. */
export function sourceIdOf(parent: number, repository = SOURCE_REPOSITORY): string {
  return issueKey(parent, repository);
}

/** The fixture target of one workspace of the shared fixture. */
export function workspaceTarget(workspace: Workspace): FixtureTarget {
  return {
    root: workspace.root,
    github: workspace.github,
    run: (args) => runJson(workspace, args),
  };
}
