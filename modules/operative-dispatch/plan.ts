// Bun has no path manipulation API.
import { basename, dirname } from "node:path";
import { ContentIdentity } from "../content-identity/main.ts";

export type Brief = {
  assignmentId: string;
  attemptId: string;
  sourceId: string;
  sourceKey: string;
  sourceRevision: string;
  title: string;
  kind: string;
  approvedScope: string;
  acceptanceRequirements: string[];
  permissions: { writePaths: string[]; allowedCommands: string[]; network: boolean };
  fixedInputs: Array<{
    name: string;
    kind: string;
    value: string;
    contentIdentity: string | null;
  }>;
};

export type Snapshot = {
  selection: {
    crew: { host: string | null; model: string | null };
  };
  release: { version: string; identity: string };
  lock: { name: string | null; state: string; identity: string | null; path: string | null };
  skills: { identity: string };
};

export type DispatchPlan = {
  assignmentId: string;
  attemptId: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
  agentName: string;
  agentKind: string;
  agentHost: string;
  briefPath: string;
  briefText: string;
  briefIdentity: string;
  promptText: string;
  promptIdentity: string;
  snapshotIdentity: string;
};

// The recorded host names stay full; Herdr names the executable it starts.
const agentKindByHost = { "claude-code": "claude", opencode: "opencode" } as const;

export const BRIEF_PATH = ".operator/local/brief.md";
export const REFERENCE_PATH = ".operator/local/attempt.json";
export const RELEASE_PATH = ".operator/local/release.json";

export function isSupportedHost(host: string | null): host is keyof typeof agentKindByHost {
  return host !== null && Object.hasOwn(agentKindByHost, host);
}

/** Herdr names an agent `[a-z][a-z0-9_-]{0,31}`, so the attempt contributes a short suffix. */
function shortId(attemptId: string): string {
  return attemptId.replaceAll(/[^a-z0-9]/g, "").slice(0, 8);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 24) || "work"
  );
}

function briefDocument(request: {
  brief: Brief;
  snapshot: Snapshot;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  controllingCheckout: string;
}): string {
  const { brief, snapshot } = request;

  return [
    `# Operative brief for attempt ${brief.attemptId}`,
    "",
    "## Identity",
    "",
    `- Assignment: ${brief.assignmentId}`,
    `- Attempt: ${brief.attemptId}`,
    `- Source: ${brief.sourceId} item ${brief.sourceKey} at revision ${brief.sourceRevision}`,
    `- Assignment kind: ${brief.kind}`,
    `- Controlling checkout: ${request.controllingCheckout}`,
    `- Worktree: ${request.worktreePath}`,
    `- Branch: ${request.branch} from commit ${request.baseCommit}`,
    "",
    "## Approved scope",
    "",
    brief.title,
    "",
    brief.approvedScope,
    "",
    "## Acceptance requirements",
    "",
    ...brief.acceptanceRequirements.map((one) => `- ${one}`),
    "",
    "## Authority limits",
    "",
    "Write only inside these paths:",
    ...brief.permissions.writePaths.map((one) => `- ${one}`),
    "",
    "Run only these commands:",
    ...brief.permissions.allowedCommands.map((one) => `- ${one}`),
    "",
    `Network access: ${brief.permissions.network ? "permitted" : "not permitted"}.`,
    "",
    "Work outside these limits needs a question to the Operator, never your own decision.",
    "",
    "## Fixed inputs",
    "",
    ...(brief.fixedInputs.length === 0
      ? ["This assignment fixes no inputs."]
      : brief.fixedInputs.map(
          (one) =>
            `- ${one.name} (${one.kind}): ${one.value}${
              one.contentIdentity === null ? "" : ` [${one.contentIdentity}]`
            }`,
        )),
    "",
    "These inputs are fixed at dispatch. A later change to their source does not change them.",
    "",
    "## Effective configuration",
    "",
    `- Crew host: ${snapshot.selection.crew.host ?? "unnamed"}`,
    `- Crew model: ${snapshot.selection.crew.model ?? "host default"}`,
    `- Operator release: ${snapshot.release.version} (${snapshot.release.identity})`,
    `- Lock data: ${snapshot.lock.name ?? "none"} (${snapshot.lock.identity ?? "none"})`,
    `- Skills: ${snapshot.skills.identity}`,
    "",
    "## Reporting protocol",
    "",
    "Acknowledge this assignment before you change any file:",
    "",
    "```",
    `operator attempt acknowledge --request <a new identity you generate> --attempt ${brief.attemptId} --json`,
    "```",
    "",
    "Run it from this worktree.",
    "The Operator treats you as started only after that acknowledgement.",
    "Report progress, questions, and results through the Operator CLI, never through terminal text alone.",
    "",
  ].join("\n");
}

function promptDocument(brief: Brief): string {
  return [
    `You are the Operative on Operator attempt ${brief.attemptId} for assignment ${brief.assignmentId}.`,
    `Read ${BRIEF_PATH} in this worktree first. It carries your scope, authority limits, and reporting protocol.`,
    `Then acknowledge the assignment with: operator attempt acknowledge --request <a new identity you generate> --attempt ${brief.attemptId} --json`,
    "Do not change any file before that acknowledgement succeeds.",
  ].join("\n");
}

/**
 * Names every input of one launch before any external effect happens.
 * The plan is a pure function of the assignment, the snapshot, and the named commit, so an
 * interrupted dispatch recomputes the same branch, checkout, agent, brief, and prompt.
 */
export function planDispatch(request: {
  projectRoot: string;
  brief: Brief;
  snapshot: Snapshot;
  baseCommit: string;
  branch: string | null;
  worktreePath: string | null;
  agentHost: string;
  agentKind: string;
}): DispatchPlan {
  const short = shortId(request.brief.attemptId);
  const branch = request.branch ?? `operator/${slug(request.brief.sourceKey)}-${short}`;
  const worktreePath =
    request.worktreePath ??
    `${dirname(request.projectRoot)}/${basename(request.projectRoot)}-operative-${short}`;

  const briefText = briefDocument({
    brief: request.brief,
    snapshot: request.snapshot,
    worktreePath,
    branch,
    baseCommit: request.baseCommit,
    controllingCheckout: request.projectRoot,
  });
  const briefIdentity = ContentIdentity.ofText(briefText);
  const promptText = promptDocument(request.brief);

  return {
    assignmentId: request.brief.assignmentId,
    attemptId: request.brief.attemptId,
    baseCommit: request.baseCommit,
    branch,
    worktreePath,
    agentName: `operative-${short}`,
    agentKind: request.agentKind,
    agentHost: request.agentHost,
    briefPath: BRIEF_PATH,
    briefText,
    briefIdentity,
    promptText,
    // Delivery identity covers the brief the prompt points at, so a changed brief is a new prompt.
    promptIdentity: ContentIdentity.of({ promptText, briefIdentity }),
    snapshotIdentity: ContentIdentity.of(request.snapshot),
  };
}

export function agentKindFor(host: string): string {
  return isSupportedHost(host) ? agentKindByHost[host] : host;
}
