import { ContentIdentity } from "../content-identity/main.ts";
import {
  requestId as request,
  runJson,
  type Workspace,
  type Workspaces,
} from "./workspace-fixture.ts";

export const REPOSITORY = "fveracoechea/operator";
export const TICKET = 24;
export const MAP_ISSUE = 1;
export const ACTOR = "operator-bot";

export const MAP_BASELINE = ["# Map", "", "## Decisions so far", "", "- nothing yet"].join("\n");
export const MAP_BASELINE_IDENTITY = ContentIdentity.ofText(MAP_BASELINE);

type FakeComment = {
  id: number;
  html_url: string;
  user: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
};

type FakeIssue = {
  number: number;
  state: string;
  state_reason: string | null;
  closed_by: { login: string } | null;
  closed_at: string | null;
  updated_at: string;
  title: string;
  body: string;
};

type FakeEvent = {
  event: string;
  actor: { login: string } | null;
  state_reason: string | null;
  created_at: string;
};

export type GithubState = {
  viewer: string;
  nextCommentId: number;
  issues: Record<string, FakeIssue>;
  comments: Record<string, FakeComment[]>;
  events: Record<string, FakeEvent[]>;
};

export type TrackerWorkspace = Workspace & {
  ownerToken: string;
  assignmentId: string;
};

function issue(number: number, body: string): FakeIssue {
  return {
    number,
    state: "open",
    state_reason: null,
    closed_by: null,
    closed_at: null,
    updated_at: "2026-09-01T00:00:00Z",
    title: `Issue ${number}`,
    body,
  };
}

export async function githubState(workspace: Workspace): Promise<GithubState> {
  const state: GithubState = await Bun.file(`${workspace.github}/state.json`).json();
  return state;
}

export async function writeGithubState(workspace: Workspace, state: GithubState): Promise<void> {
  await Bun.write(`${workspace.github}/state.json`, `${JSON.stringify(state, null, 2)}\n`);
}

/** Injects one fault into the GitHub fake for the next `times` calls of that operation. */
export async function setFault(
  workspace: Workspace,
  name: string,
  kind: "lost" | "applied-lost" | `status:${number}`,
  times = 1,
): Promise<void> {
  const path = `${workspace.github}/faults.json`;
  const file = Bun.file(path);
  const held: Record<string, { kind: string; remaining: number }> = (await file.exists())
    ? await file.json()
    : {};
  held[name] = { kind, remaining: times };
  await Bun.write(path, `${JSON.stringify(held, null, 2)}\n`);
}

export async function writeInput(workspace: Workspace, value: unknown): Promise<string> {
  const path = `${workspace.root}/tracker-input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

/**
 * One owned crew holding one registered production assignment that is bound to a GitHub ticket,
 * with the tracker seeded as an open issue and an open map issue.
 */
export async function makeTrackerWorkspace(
  fixtures: Workspaces,
  options: { mapIssue?: number | null; trackerIssue?: number | null } = {},
): Promise<TrackerWorkspace> {
  const workspace = await fixtures.make();
  const mapIssue = options.mapIssue === undefined ? MAP_ISSUE : options.mapIssue;
  const trackerIssue = options.trackerIssue === undefined ? TICKET : options.trackerIssue;

  await writeGithubState(workspace, {
    viewer: ACTOR,
    nextCommentId: 1,
    issues: {
      [String(TICKET)]: issue(TICKET, "The ticket body."),
      [String(MAP_ISSUE)]: issue(MAP_ISSUE, MAP_BASELINE),
    },
    comments: {},
    events: {},
  });

  const owned = await runJson(workspace, [
    "crew",
    "own",
    "--request",
    request(),
    "--owner-label",
    "operator-session",
  ]);
  const ownerToken = owned.json.data.ownerToken;

  const inputPath = await writeInput(workspace, {
    sourceKind: "wayfinder",
    source: {
      id: `github:${REPOSITORY}#${MAP_ISSUE}`,
      revision: "rev-1",
      tracker: "github",
      target: { repository: REPOSITORY, mapIssue },
    },
    items: [
      {
        key: String(TICKET),
        title: "Complete and recover GitHub tracker updates",
        wayfinderType: "task",
        ...(trackerIssue === null ? {} : { trackerIssue }),
        approvedScope: "Build the tracker completion path.",
        acceptanceRequirements: ["The quality gate passes."],
        permissions: { writePaths: ["modules/"], allowedCommands: ["bun test"], network: false },
        fixedInputs: [],
        dependsOn: [],
      },
    ],
  });

  const registered = await runJson(workspace, [
    "work",
    "register",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--input",
    inputPath,
  ]);

  return {
    ...workspace,
    ownerToken,
    assignmentId: registered.json.data.registered[0].assignmentId,
  };
}

export function resolutionBody(text = "The work is complete and reviewed."): unknown {
  return { step: "resolution", body: `## Resolution\n\n${text}` };
}

export function completionBody(reason: "completed" | "not_planned" = "completed"): unknown {
  return { step: "completion", reason };
}

export function amendmentBody(
  options: {
    sections?: string[];
    supersedes?: string[];
    baselineIdentity?: string;
    body?: string;
    mode?: "amendment" | "replace-body";
  } = {},
): unknown {
  return {
    step: "map_amendment",
    mode: options.mode ?? "amendment",
    decisionLink: `https://github.com/${REPOSITORY}/issues/${TICKET}#issuecomment-1`,
    baselineIdentity: options.baselineIdentity ?? MAP_BASELINE_IDENTITY,
    sections: options.sections ?? ["Decisions so far"],
    supersedes: options.supersedes ?? [],
    body: options.body ?? "- The tracker decision is recorded.",
  };
}

export async function recordStep(
  workspace: TrackerWorkspace,
  options: { input: unknown; revision?: number; approvalId?: string; requestId?: string },
) {
  return runJson(workspace, [
    "tracker",
    "record",
    "--request",
    options.requestId ?? request(),
    "--owner-token",
    workspace.ownerToken,
    "--assignment",
    workspace.assignmentId,
    "--revision",
    String(options.revision ?? 1),
    "--input",
    await writeInput(workspace, options.input),
    ...(options.approvalId === undefined ? [] : ["--approval", options.approvalId]),
  ]);
}

export async function recoverStep(workspace: TrackerWorkspace, operationId: string) {
  return runJson(workspace, [
    "tracker",
    "recover",
    "--request",
    request(),
    "--owner-token",
    workspace.ownerToken,
    "--operation",
    operationId,
  ]);
}

export async function showSteps(workspace: TrackerWorkspace) {
  return runJson(workspace, ["tracker", "show", "--assignment", workspace.assignmentId]);
}

export async function readMap(workspace: TrackerWorkspace) {
  return runJson(workspace, ["tracker", "map", "--assignment", workspace.assignmentId]);
}

/** A person's approval for another write under one uncertain operation. */
export async function grantAdditionalWrite(
  workspace: TrackerWorkspace,
  options: { operationId: string; issue: number; scope: string; requestRevision: string },
): Promise<string> {
  const granted = await runJson(workspace, [
    "approval",
    "grant",
    "--request",
    request(),
    "--owner-token",
    workspace.ownerToken,
    "--input",
    await writeInput(workspace, {
      action: "tracker.additional_write",
      targets: [`github:${REPOSITORY}#${options.issue}`, `operation:${options.operationId}`],
      scope: options.scope,
      requestRevision: options.requestRevision,
      exactText: "Yes, write it again. I accept a possible duplicate comment.",
      grantedBy: "human",
    }),
  ]);
  return granted.json.data.approvalId;
}
