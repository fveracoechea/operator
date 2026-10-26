import { sha256 } from "../../lib/sha256.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { editConfig, parseEdits, type Edit } from "./edits.ts";
import {
  externallyManaged,
  isIoFailure,
  readConfig,
  readReceipt,
  withWriteLock,
  writeConfig,
  writeEditorSchema,
  writeReceipt,
  type Receipt,
} from "./storage.ts";
import { decideSettingsWrite } from "./state-machine.ts";
import { validateSelections } from "./validation.ts";
import type { AgentHosts } from "../agent-hosts/main.ts";
import type { SelectionFailure } from "./selection.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;
type HostFailure = Extract<Awaited<ReturnType<typeof AgentHosts.resolve>>, { tag: "Err" }>["error"];

export type SettingsFailure =
  | HostFailure
  | SelectionFailure
  | {
      reason:
        | "invalid_settings_edit"
        | "settings_recovery_required"
        | "settings_plan_required"
        | "settings_plan_stale"
        | "settings_external"
        | "settings_write_unconfirmed";
      detail: string;
    };
export type SettingsOutcome =
  | {
      reason:
        | "settings_read"
        | "settings_planned"
        | "settings_applied"
        | "settings_unchanged"
        | "settings_recovered";
      data: unknown;
    }
  | SettingsFailure;
export type ChangeRequest = {
  paths: OperatorPaths;
  sets: string[];
  unsets: string[];
  planId?: string;
  cwd?: string;
};

const recoveryRequired: SettingsFailure = {
  reason: "settings_recovery_required",
  detail:
    "Run operator config recover before another settings write. Preserve an unreadable or unmatched receipt for inspection.",
};
const writeUnconfirmed: SettingsFailure = {
  reason: "settings_write_unconfirmed",
  detail:
    "The settings write could not be verified. Run operator config recover before another edit.",
};
const externallyOwned: SettingsFailure = {
  reason: "settings_external",
  detail:
    "Settings are linked or read-only. Edit the external configuration, such as your Nix or Home Manager configuration, then rebuild it. Operator will not replace its file or link.",
};

function makePlan(
  paths: OperatorPaths,
  read: Awaited<ReturnType<typeof readConfig>>,
  receipt: Receipt | null,
  edits: Edit[],
) {
  const changed = editConfig(read.config, edits);
  if (!changed.success)
    return {
      reason: "invalid_settings_edit",
      detail: changed.error.message,
    } satisfies SettingsFailure;
  const nextText = `${JSON.stringify(changed.data, null, 2)}\n`;
  const generation = receipt?.state === "pending" ? receipt.generation : (receipt?.planId ?? null);
  const editsIdentity = sha256(JSON.stringify(edits));
  return {
    planId: sha256(
      JSON.stringify({
        path: paths.config,
        receipt: paths.receipt,
        generation,
        previousIdentity: read.identity,
        nextText,
        editsIdentity,
      }),
    ),
    generation,
    editsIdentity,
    previousIdentity: read.identity,
    nextIdentity: sha256(nextText),
    nextText,
    changed: !read.exists || JSON.stringify(changed.data) !== JSON.stringify(read.config),
    path: paths.config,
    before: read.config,
    after: changed.data,
  };
}

export async function plan(request: ChangeRequest): Promise<SettingsOutcome> {
  const parsed = parseEdits(request.sets, request.unsets);
  if (parsed.issues !== undefined)
    return { reason: "invalid_settings_edit", detail: parsed.issues.join("\n") };
  const receipt = await readReceipt(request.paths);
  if (receipt === "unreadable" || receipt?.state === "pending") return recoveryRequired;
  const planned = makePlan(request.paths, await readConfig(request.paths), receipt, parsed.edits);
  if (planned.reason !== undefined) return planned;
  const invalid = await validateSelections(planned.after, request.cwd ?? process.cwd());
  return invalid ?? { reason: "settings_planned", data: planned };
}

async function applyLocked(request: ChangeRequest, edits: Edit[]): Promise<SettingsOutcome> {
  const { paths } = request;
  const receipt = await readReceipt(paths);
  if (receipt === "unreadable") return recoveryRequired;
  const read = await readConfig(paths);
  const planned = makePlan(paths, read, receipt, edits);
  if (planned.reason !== undefined) return planned;
  const decision = decideSettingsWrite("apply", {
    state: receipt?.state ?? "absent",
    receipt,
    identity: read.identity,
    planId: request.planId,
    editsIdentity: planned.editsIdentity,
    freshPlanId: planned.planId,
    changed: planned.changed,
  });
  if (decision === "repeat" && receipt !== null) {
    if (receipt.state === "pending") await writeReceipt(paths, { ...receipt, state: "complete" });
    return { reason: "settings_unchanged", data: { repeated: true } };
  }
  if (decision === "recovery-required") return recoveryRequired;
  if (decision === "stale")
    return {
      reason: "settings_plan_stale",
      detail: "The inspected settings or receipt changed. Make a new plan.",
    };
  if (decision === "unchanged") return { reason: "settings_unchanged", data: { repeated: false } };
  if (await externallyManaged(paths)) return externallyOwned;
  return writePlanned(paths, planned);
}

async function writePlanned(
  paths: OperatorPaths,
  planned: Exclude<ReturnType<typeof makePlan>, SettingsFailure>,
): Promise<SettingsOutcome> {
  const pending: Receipt = {
    planId: planned.planId,
    generation: planned.generation,
    editsIdentity: planned.editsIdentity,
    previousIdentity: planned.previousIdentity,
    nextIdentity: planned.nextIdentity,
    state: "pending",
  };
  try {
    await writeReceipt(paths, pending);
    const written = await writeConfig(paths, planned.nextText, planned.previousIdentity);
    if (written === "stale") {
      await writeReceipt(paths, { ...pending, state: "aborted" });
      return {
        reason: "settings_plan_stale",
        detail: "The settings changed before the write. Make a new plan.",
      };
    }
    if (written === "unconfirmed") return writeUnconfirmed;
    await writeReceipt(paths, { ...pending, state: "complete" });
  } catch (error) {
    if (isIoFailure(error)) return writeUnconfirmed;
    // oxlint-disable-next-line unthrown/no-throw -- Unexpected defects retain the pending receipt and reach the command boundary.
    throw error;
  }
  await writeEditorSchema(paths);
  return { reason: "settings_applied", data: planned };
}

export async function apply(request: ChangeRequest): Promise<SettingsOutcome> {
  const parsed = parseEdits(request.sets, request.unsets);
  if (parsed.issues !== undefined)
    return { reason: "invalid_settings_edit", detail: parsed.issues.join("\n") };
  if (request.planId === undefined)
    return {
      reason: "settings_plan_required",
      detail: "Run operator config plan with these edits, then pass its ID with --plan.",
    };
  if (await externallyManaged(request.paths)) return externallyOwned;
  const changed = editConfig((await readConfig(request.paths)).config, parsed.edits);
  if (!changed.success) return { reason: "invalid_settings_edit", detail: changed.error.message };
  const invalid = await validateSelections(changed.data, request.cwd ?? process.cwd());
  if (invalid) return invalid;
  return withWriteLock(request.paths, () => applyLocked(request, parsed.edits));
}

export async function recover(paths: OperatorPaths): Promise<SettingsOutcome> {
  return withWriteLock(paths, async () => {
    const receipt = await readReceipt(paths);
    if (receipt === "unreadable") return recoveryRequired;
    const current = await readConfig(paths);
    const state = decideSettingsWrite("recover", {
      state: receipt?.state ?? "absent",
      receipt,
      identity: current.identity,
    });
    if (state === "nothing")
      return {
        reason: "settings_recovered",
        data: { state: receipt?.state ?? "absent" },
      };
    if ((state !== "complete" && state !== "aborted") || receipt === null) return recoveryRequired;
    await writeReceipt(paths, { ...receipt, state });
    return { reason: "settings_recovered", data: { state, planId: receipt.planId } };
  });
}
