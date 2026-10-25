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

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

export type SettingsFailure = {
  reason:
    | "invalid_settings_edit"
    | "settings_recovery_required"
    | "settings_plan_required"
    | "settings_plan_stale"
    | "settings_external"
    | "settings_write_unconfirmed";
  detail: string;
  exitCode: 2 | 3 | 4 | 5;
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
      exitCode: 0;
    }
  | SettingsFailure;
export type ChangeRequest = {
  paths: OperatorPaths;
  sets: string[];
  unsets: string[];
  planId?: string;
};

function failure(
  reason: SettingsFailure["reason"],
  detail: string,
  exitCode: SettingsFailure["exitCode"],
): SettingsFailure {
  return { reason, detail, exitCode };
}
function recovery() {
  return failure(
    "settings_recovery_required",
    "Run operator config recover before another settings write. Preserve an unreadable or unmatched receipt for inspection.",
    3,
  );
}

function makePlan(
  paths: OperatorPaths,
  read: Awaited<ReturnType<typeof readConfig>>,
  receipt: Receipt | null,
  edits: Edit[],
) {
  const changed = editConfig(read.config, edits);
  if (!changed.success) return failure("invalid_settings_edit", changed.error.message, 2);
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
    return failure("invalid_settings_edit", parsed.issues.join("\n"), 2);
  const receipt = await readReceipt(request.paths);
  if (receipt === "unreadable" || receipt?.state === "pending") return recovery();
  const planned = makePlan(request.paths, await readConfig(request.paths), receipt, parsed.edits);
  return "exitCode" in planned
    ? planned
    : { reason: "settings_planned", data: planned, exitCode: 0 };
}

async function applyLocked(request: ChangeRequest, edits: Edit[]): Promise<SettingsOutcome> {
  const { paths } = request;
  const receipt = await readReceipt(paths);
  if (receipt === "unreadable") return recovery();
  const read = await readConfig(paths);
  const planned = makePlan(paths, read, receipt, edits);
  if ("exitCode" in planned) return planned;
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
    return { reason: "settings_unchanged", data: { repeated: true }, exitCode: 0 };
  }
  if (decision === "recovery-required") return recovery();
  if (decision === "stale")
    return failure(
      "settings_plan_stale",
      "The inspected settings or receipt changed. Make a new plan.",
      4,
    );
  if (decision === "unchanged")
    return { reason: "settings_unchanged", data: { repeated: false }, exitCode: 0 };
  if (await externallyManaged(paths)) return external();
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
      return failure(
        "settings_plan_stale",
        "The settings changed before the write. Make a new plan.",
        4,
      );
    }
    if (written === "unconfirmed") return unconfirmed();
    await writeReceipt(paths, { ...pending, state: "complete" });
  } catch (error) {
    if (isIoFailure(error)) return unconfirmed();
    // oxlint-disable-next-line unthrown/no-throw -- Unexpected defects retain the pending receipt and reach the command boundary.
    throw error;
  }
  await writeEditorSchema(paths);
  return { reason: "settings_applied", data: planned, exitCode: 0 };
}

function unconfirmed() {
  return failure(
    "settings_write_unconfirmed",
    "The settings write could not be verified. Run operator config recover before another edit.",
    5,
  );
}

function external() {
  return failure(
    "settings_external",
    "Settings are linked or read-only. Edit the external configuration, such as your Nix or Home Manager configuration, then rebuild it. Operator will not replace its file or link.",
    3,
  );
}

export async function apply(request: ChangeRequest): Promise<SettingsOutcome> {
  const parsed = parseEdits(request.sets, request.unsets);
  if (parsed.issues !== undefined)
    return failure("invalid_settings_edit", parsed.issues.join("\n"), 2);
  if (request.planId === undefined)
    return failure(
      "settings_plan_required",
      "Run operator config plan with these edits, then pass its ID with --plan.",
      3,
    );
  if (await externallyManaged(request.paths)) return external();
  return withWriteLock(request.paths, () => applyLocked(request, parsed.edits));
}

export async function recover(paths: OperatorPaths): Promise<SettingsOutcome> {
  return withWriteLock(paths, async () => {
    const receipt = await readReceipt(paths);
    if (receipt === "unreadable") return recovery();
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
        exitCode: 0,
      };
    if ((state !== "complete" && state !== "aborted") || receipt === null) return recovery();
    await writeReceipt(paths, { ...receipt, state });
    return { reason: "settings_recovered", data: { state, planId: receipt.planId }, exitCode: 0 };
  });
}
