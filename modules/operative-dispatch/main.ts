import { HerdrControl } from "../herdr-control/main.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { ReleaseInstall } from "../release-install/main.ts";
import { type AnswerDelivery, answerDocument } from "./answer.ts";
import { prepareInputs } from "./inputs.ts";
import { inspectCheckout, inspectWork, type WorkInspection } from "./inspect.ts";
import { type PlanningInput, planningRecordsSection } from "./planning-brief.ts";
import { readReference } from "./reference.ts";
import { BRIEF_PATH, LOCAL_ROOT, opencodeFiles, REFERENCE_PATH, RELEASE_PATH } from "./plan.ts";
import { readSnapshot } from "./snapshot.ts";
import { scanOutside } from "./scan.ts";
import {
  agentKindFor,
  type Brief,
  type DispatchPlan,
  hasAgentKind,
  planDispatch,
  type Snapshot,
} from "./plan.ts";

type SnapshotDrift = { input: string; recorded: string; current: string };

/** The recorded kinds of outside effect this module performs. */
type StageKind = "worktree_create" | "input_preparation" | "agent_start" | "prompt_delivery";
const ANSWER_DELIVERY = "answer_delivery";

type PerformRequest =
  | {
      kind: StageKind;
      projectRoot: string;
      plan: DispatchPlan;
      snapshot: Snapshot;
      /** The Herdr workspace the recorded checkout holds, or null before one is recorded. */
      workspaceId: string | null;
    }
  | { kind: typeof ANSWER_DELIVERY; agentName: string; answer: AnswerDelivery; snapshot: Snapshot };

type StageRequest = Extract<PerformRequest, { kind: StageKind }>;

/** The outcome event of one performed effect. A failure detail starts with its code. */
type Performed =
  | { status: "succeeded"; detail: string; workspaceId?: string; paneId?: string }
  | { status: "failed"; detail: string }
  | { status: "uncertain"; detail: string };

type Unsettled =
  | { status: "failed"; code: string; detail: string }
  | { status: "uncertain"; detail: string };

/** Reads one Herdr answer that did not succeed. The one place a failure code joins its detail. */
function unsettledOf(outcome: Unsettled): Performed {
  return outcome.status === "failed"
    ? { status: "failed", detail: `${outcome.code}: ${outcome.detail}` }
    : { status: "uncertain", detail: outcome.detail };
}

/** Reads one Herdr answer as an outcome event. */
function outcomeOf<Value>(
  outcome: { status: "succeeded"; value: Value } | Unsettled,
  succeeded: (value: Value) => Performed,
): Performed {
  return outcome.status === "succeeded" ? succeeded(outcome.value) : unsettledOf(outcome);
}

function describe(value: string | null): string {
  return value ?? "none";
}

async function createWorktree({ projectRoot, plan }: StageRequest): Promise<Performed> {
  const input: Parameters<typeof HerdrControl.createWorktree>[0] = {
    repoRoot: projectRoot,
    path: plan.worktreePath,
    branch: plan.branch,
    baseCommit: plan.baseCommit,
    label: plan.workspaceLabel,
    tabLabel: plan.tabLabel,
  };
  if (plan.parentWorkspaceId !== undefined) {
    input.parentWorkspaceId = plan.parentWorkspaceId;
  }
  return outcomeOf(await HerdrControl.createWorktree(input), (created) => ({
    status: "succeeded",
    detail: `Created ${created.worktree.path}.`,
    workspaceId: created.workspaceId,
  }));
}

/** Copies and verifies the fixed inputs one Operative worktree needs, and no credential. */
async function prepare({ projectRoot, plan, snapshot }: StageRequest): Promise<Performed> {
  const prepared = await prepareInputs({ projectRoot, plan, snapshot });
  return prepared.status === "prepared"
    ? { status: "succeeded", detail: `Copied and verified ${prepared.inputs.length} input(s).` }
    : { status: "failed", detail: `${prepared.reason}: ${prepared.detail}` };
}

/** Starts the selected agent host in the checkout's own pane, read fresh from its workspace. */
async function startAgent({ plan, workspaceId }: StageRequest): Promise<Performed> {
  if (workspaceId === null) {
    return { status: "failed", detail: "The recorded checkout names no Herdr workspace." };
  }
  const pane = await HerdrControl.findRootPane({ workspaceId });
  if (pane.status === "absent") {
    return {
      status: "failed",
      detail: `workspace_not_found: Herdr holds no workspace ${workspaceId} to launch in.`,
    };
  }
  if (pane.status === "unknown") {
    return { status: "uncertain", detail: pane.detail };
  }

  const started = await HerdrControl.startAgent({
    name: plan.agentName,
    kind: plan.agentKind,
    paneId: pane.value.paneId,
    model: plan.agentModel,
    reasoningEffort: plan.agentReasoningEffort,
    allowedTools: plan.allowedTools,
  });
  if (started.status !== "succeeded") {
    return unsettledOf(started);
  }

  const { paneId, status } = started.value;
  const labeled = await HerdrControl.labelAgent({
    paneId,
    agentName: plan.agentName,
    label: plan.agentLabel,
  });
  const warning =
    labeled.status === "succeeded"
      ? ""
      : labeled.status === "failed"
        ? ` Display label failed: ${labeled.code}: ${labeled.detail}.`
        : ` Display label unconfirmed: ${labeled.detail}.`;
  return {
    status: "succeeded",
    detail: `Started ${plan.agentName} (${status}) in pane ${paneId}.${warning}`,
    paneId,
  };
}

/** Submits one prompt. Success means Herdr accepted the submission, not a turn. */
async function submit(target: string, text: string, subject: string): Promise<Performed> {
  return outcomeOf(await HerdrControl.submitPrompt({ target, text }), () => ({
    status: "succeeded",
    detail: `Submitted the ${subject} to ${target}.`,
  }));
}

/** The outside effect of each launch stage. Crew state decides which stage runs, in order. */
const STAGE_EFFECTS: Record<StageKind, (request: StageRequest) => Promise<Performed>> = {
  worktree_create: createWorktree,
  input_preparation: prepare,
  agent_start: startAgent,
  prompt_delivery: ({ plan }) => submit(plan.agentName, plan.promptText, "brief"),
};

/** Carries one recorded answer to the Operative that asked for it. */
function performAnswerDelivery(
  request: Extract<PerformRequest, { kind: typeof ANSWER_DELIVERY }>,
): Promise<Performed> {
  const invocation = ReleaseInstall.invocation(request.snapshot.installation ?? {});
  return submit(request.agentName, answerDocument(request.answer, invocation), "answer");
}

export const OperativeDispatch = {
  /**
   * Reads the control reference one Operative worktree carries.
   * It names the controlling checkout, so an Operative never searches nearby directories for
   * the crew state that governs it.
   */
  async readReference(request: { worktreePath: string }) {
    return readReference(request.worktreePath);
  },

  /**
   * Reads one recorded launch snapshot.
   * A record this release cannot read blocks its attempt instead of launching against a guess.
   */
  readSnapshot(request: { recorded: string }) {
    return readSnapshot(request.recorded);
  },

  /**
   * The files one launch writes into an Operative worktree.
   * A cleanup preserves exactly this list, so the launch and the disposal read one rendering
   * of what Operator put there.
   * The brief carries the identity the launch recorded for it, which is the only launch input
   * whose exact expected content survives in the crew state. A cleanup can therefore notice an
   * edit to it, even though Operator's own paths are excluded from the checkout reading.
   */
  launchInputs(request: { briefIdentity: string; snapshot: string }): Array<{
    name: string;
    path: string;
    expected: string | null;
  }> {
    const stored = readSnapshot(request.snapshot);
    const effort =
      stored.status === "read" && stored.snapshot.selection.crew.host === "opencode"
        ? stored.snapshot.selection.crew.reasoningEffort
        : null;
    return [
      { name: "brief", path: BRIEF_PATH, expected: request.briefIdentity },
      ...(effort === null || effort === undefined
        ? []
        : opencodeFiles(effort).map((file) => ({
            name: file.name,
            path: file.path,
            expected: ContentIdentity.ofText(file.text),
          }))),
      { name: "control-reference", path: REFERENCE_PATH, expected: null },
      { name: "release", path: RELEASE_PATH, expected: null },
    ];
  },

  /**
   * The path prefixes Operator itself writes inside an Operative worktree.
   * Anything outside them is the occupant's own work, whichever reader is asking.
   */
  writtenPrefixes(request: { agentHost: string }): string[] {
    const prefixes = [LOCAL_ROOT];
    if (hasAgentKind(request.agentHost)) {
      prefixes.push(`${SkillInstall.targetRoot({ target: request.agentHost })}/`);
    }
    if (request.agentHost === "opencode")
      prefixes.push(...opencodeFiles("").map((file) => file.path));
    return prefixes;
  },

  /**
   * Renders the planning records one brief carries.
   * The spec copy that a result review reads renders the same section, so the Spec axis reads
   * the decisions in the words that the producer received.
   */
  planningRecordsSection(request: { inputs: PlanningInput[] }): string[] {
    return planningRecordsSection(request.inputs);
  },

  /** Names the branch, checkout, agent, brief, and prompt of one launch before any effect. */
  plan(request: {
    projectRoot: string;
    brief: Brief;
    snapshot: Snapshot;
    baseCommit: string;
    branch: string | null;
    worktreePath: string | null;
  }):
    | { status: "planned"; plan: DispatchPlan }
    | { status: "host-unnamed" }
    | { status: "effort-unsupported"; detail: string } {
    const host = request.snapshot.selection.crew.host;
    if (!hasAgentKind(host)) {
      return { status: "host-unnamed" };
    }

    const effort = request.snapshot.selection.crew.reasoningEffort;
    const model = request.snapshot.selection.crew.model;
    if (effort && host === "opencode" && (model === null || !model.startsWith("openai/"))) {
      return {
        status: "effort-unsupported",
        detail: `OpenCode needs an explicit OpenAI crew model to apply reasoning effort ${effort}; selected model: ${model ?? "host default"}.`,
      };
    }

    return {
      status: "planned",
      plan: planDispatch({ ...request, agentHost: host, agentKind: agentKindFor(host) }),
    };
  },

  /**
   * Compares a recorded launch snapshot against the current installation.
   * Recovery restores what an attempt was launched with, so a drifted input is reported
   * instead of being replaced by the current default.
   */
  verifySnapshot(request: { recorded: Snapshot; current: Snapshot }): SnapshotDrift[] {
    const pairs: Array<[string, string | null, string | null]> = [
      ["release.version", request.recorded.release.version, request.current.release.version],
      ["release.identity", request.recorded.release.identity, request.current.release.identity],
      ["lock.identity", request.recorded.lock.identity, request.current.lock.identity],
      [
        "installation.delivery",
        request.recorded.installation?.delivery ?? null,
        request.current.installation?.delivery ?? null,
      ],
      [
        "installation.commit",
        request.recorded.installation?.commit ?? null,
        request.current.installation?.commit ?? null,
      ],
      [
        "installation.packageVersion",
        request.recorded.installation?.packageVersion ?? null,
        request.current.installation?.packageVersion ?? null,
      ],
      ["skills.identity", request.recorded.skills.identity, request.current.skills.identity],
      [
        "selection.crew.host",
        request.recorded.selection.crew.host,
        request.current.selection.crew.host,
      ],
      [
        "selection.crew.model",
        request.recorded.selection.crew.model,
        request.current.selection.crew.model,
      ],
      [
        "selection.crew.reasoningEffort",
        request.recorded.selection.crew.reasoningEffort ?? null,
        request.current.selection.crew.reasoningEffort ?? null,
      ],
    ];

    return pairs
      .filter(([, recorded, current]) => recorded !== current)
      .map(([input, recorded, current]) => ({
        input,
        recorded: describe(recorded),
        current: describe(current),
      }));
  },

  /**
   * Performs one recorded outside effect of a launch or of an answer delivery, and gives the
   * outcome the crew state settles it with. Success of a submission means Herdr accepted it,
   * not a turn, so the Operative's own acknowledgement stays the only proof of arrival.
   */
  async perform(request: PerformRequest): Promise<Performed> {
    return request.kind === ANSWER_DELIVERY
      ? performAnswerDelivery(request)
      : STAGE_EFFECTS[request.kind](request);
  },

  /**
   * Reads what one checkout holds since its base: the commits, the files they touch, and the
   * files not committed. Operator writes the launch inputs and its own skills there, so those
   * paths are left out, and whatever remains is the occupant's own work.
   * A submitted result and a review report read this one inspection, so the rules that judge
   * them read Git the same way.
   */
  async inspectCheckout(request: { worktreePath: string; baseCommit: string; agentHost: string }) {
    return inspectCheckout({
      worktreePath: request.worktreePath,
      baseCommit: request.baseCommit,
      writtenPrefixes: OperativeDispatch.writtenPrefixes({ agentHost: request.agentHost }),
    });
  },

  /**
   * Scans the folder that holds one Operative worktree and the controlling checkout, as one
   * snapshot of ADR 0018. It only reads, and it never names a writer: two scans of one attempt
   * show what changed outside the worktree, whoever changed it.
   */
  async scanOutside(request: { projectRoot: string; worktreePath: string }) {
    return scanOutside(request);
  },

  /**
   * Reads what one attempt actually left behind.
   * Every call here is a read, so reconciliation and replacement never create a second writer.
   */
  async inspect(request: {
    projectRoot: string;
    agentName: string;
    worktreePath: string;
    baseCommit: string;
  }): Promise<{
    writer:
      | { state: "live"; paneId: string; status: string }
      | { state: "stopped" }
      | {
          state: "unknown";
          detail: string;
        };
    checkout: { state: "present" | "absent" } | { state: "unknown"; detail: string };
    work: WorkInspection;
  }> {
    const [agent, worktree, work] = await Promise.all([
      HerdrControl.findAgent({ name: request.agentName }),
      HerdrControl.findWorktree({ repoRoot: request.projectRoot, path: request.worktreePath }),
      inspectWork({ worktreePath: request.worktreePath, baseCommit: request.baseCommit }),
    ]);

    return {
      writer:
        agent.status === "found"
          ? { state: "live", paneId: agent.value.paneId, status: agent.value.status }
          : agent.status === "absent"
            ? { state: "stopped" }
            : { state: "unknown", detail: agent.detail },
      checkout:
        worktree.status === "unknown"
          ? { state: "unknown", detail: worktree.detail }
          : { state: worktree.status === "found" ? "present" : "absent" },
      work,
    };
  },
};
