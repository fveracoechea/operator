// Bun has no atomic file rename, directory creation, or removal API.
import { Database } from "bun:sqlite";
import { mkdir, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { AgentSelection } from "../agent-selection/main.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import {
  ConfigApply,
  type ConfigApplyEvent,
  type ConfigApplyRefusal,
  type ConfigApplyState,
  type Receipt,
  receiptSchema,
} from "./apply.ts";
import { operatorConfigSchema } from "./schema.ts";

export const CONFIG_PATH = ".operator/config.json";
const RECEIPT_PATH = ".operator/local/config-apply.json";
const WRITE_LOCK_PATH = ".operator/local/config-write.sqlite";

const editable = [
  "operator.host",
  "operator.model",
  "crew.host",
  "crew.model",
  "crew.reasoningEffort",
  "crew.maxActiveAgents",
  "probe.githubFixture.repository",
  "probe.githubFixture.issue",
  "probe.githubFixture.mapIssue",
  "probe.githubFixture",
] as const;

type Config = z.infer<typeof operatorConfigSchema>;
type Edit = { path: string; value: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One --set or --unset argument as the user wrote it. */
type Argument = {
  action: "set" | "unset";
  raw: string;
  separator: number;
  path: string;
  value: string | null;
};

/** The first rule that refuses an argument names its only issue. */
const refusals: {
  refuses: (argument: Argument, seen: Set<string>) => boolean;
  issue: (argument: Argument) => string;
}[] = [
  {
    refuses: ({ action, separator }) => action === "unset" && separator !== -1,
    issue: ({ raw }) => `Unset ${raw} with a path, without =value.`,
  },
  {
    refuses: ({ action, path }) => action === "set" && path === "probe.githubFixture",
    issue: () => "probe.githubFixture can only be unset; set its fields separately.",
  },
  {
    refuses: ({ path }) => !editable.some((allowed) => allowed === path),
    issue: ({ path, raw }) => `Unsupported configuration field: ${path || raw}.`,
  },
  {
    refuses: ({ path }, seen) => seen.has(path),
    issue: ({ path }) => `Configuration field ${path} was named more than once.`,
  },
  {
    refuses: ({ action, separator, value }) => action === "set" && (separator < 1 || value === ""),
    issue: ({ path }) => `Set ${path} with a non-empty path=value argument.`,
  },
];

function parseEdits(sets: string[], unsets: string[]): { edits: Edit[] } | { issues: string[] } {
  const issues: string[] = [];
  const edits: Edit[] = [];
  const seen = new Set<string>();
  const parsed: Argument[] = [
    ...sets.map((raw) => {
      const separator = raw.indexOf("=");
      return {
        action: "set" as const,
        raw,
        separator,
        path: raw.slice(0, separator),
        value: raw.slice(separator + 1),
      };
    }),
    ...unsets.map((raw) => ({
      action: "unset" as const,
      raw,
      separator: raw.indexOf("="),
      path: raw,
      value: null,
    })),
  ];
  for (const argument of parsed) {
    const refusal = refusals.find((rule) => rule.refuses(argument, seen));
    if (refusal !== undefined) {
      issues.push(refusal.issue(argument));
      continue;
    }
    seen.add(argument.path);
    edits.push({ path: argument.path, value: argument.value });
  }
  if (
    seen.has("probe.githubFixture") &&
    [...seen].some((path) => path.startsWith("probe.githubFixture."))
  ) {
    issues.push("Set or unset fixture fields, or unset the whole fixture, not both.");
  }
  if (edits.length === 0 && issues.length === 0)
    issues.push("Name at least one --set or --unset field.");
  return issues.length > 0
    ? { issues }
    : { edits: edits.toSorted((a, b) => a.path.localeCompare(b.path)) };
}

function change(config: Config, edits: Edit[]): unknown {
  const next: Record<string, unknown> = { ...config };
  for (const edit of edits) {
    const parts = edit.path.split(".");
    let parent = next;
    let missing = false;
    for (const part of parts.slice(0, -1)) {
      const entry = parent[part];
      if (edit.value === null && entry === undefined) {
        missing = true;
        break;
      }
      const child = isRecord(entry) ? { ...entry } : {};
      parent[part] = child;
      parent = child;
    }
    if (missing) continue;
    const name = parts.at(-1);
    if (name === undefined) continue;
    if (edit.value === null) {
      delete parent[name];
    } else {
      parent[name] = [
        "crew.maxActiveAgents",
        "probe.githubFixture.issue",
        "probe.githubFixture.mapIssue",
      ].includes(edit.path)
        ? Number(edit.value)
        : edit.value;
    }
  }
  return next;
}

async function readConfiguration(projectRoot: string) {
  const file = Bun.file(`${projectRoot}/${CONFIG_PATH}`);
  if (!(await file.exists())) return { status: "missing" as const };
  let text: string;
  let value: unknown;
  try {
    text = await file.text();
    value = JSON.parse(text);
  } catch (error) {
    return { status: "invalid" as const, issues: [String(error)] };
  }
  const parsed = operatorConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      status: "invalid" as const,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return {
    status: "read" as const,
    text,
    identity: ContentIdentity.ofText(text),
    config: parsed.data,
  };
}

function selection(config: Config) {
  return AgentSelection.resolve({
    configuration: { operator: config.operator, crew: config.crew },
    overrides: {},
  });
}

async function readReceipt(projectRoot: string) {
  const file = Bun.file(`${projectRoot}/${RECEIPT_PATH}`);
  if (!(await file.exists())) return { status: "missing" as const };
  try {
    const parsed = receiptSchema.safeParse(await file.json());
    return parsed.success
      ? { status: "read" as const, receipt: parsed.data }
      : { status: "invalid" as const, detail: parsed.error.message };
  } catch (error) {
    return { status: "invalid" as const, detail: String(error) };
  }
}

async function writeReceipt(projectRoot: string, receipt: Receipt) {
  const path = `${projectRoot}/${RECEIPT_PATH}`;
  await Bun.write(`${path}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`, {
    createPath: true,
  });
  await rename(`${path}.tmp`, path);
}

/** SQLite releases the project-local writer lock if a command exits during an apply. */
async function withWriteLock<Result>(projectRoot: string, action: () => Promise<Result>) {
  let database: Database;
  try {
    await mkdir(`${projectRoot}/.operator/local`, { recursive: true });
    database = new Database(`${projectRoot}/${WRITE_LOCK_PATH}`);
  } catch (error) {
    return { status: "write-failed" as const, detail: String(error) };
  }
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    return { status: "write-locked" as const, detail: String(error) };
  }
  try {
    return await action();
  } catch (error) {
    return { status: "write-failed" as const, detail: String(error) };
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
}

type ReceiptRead = Awaited<ReturnType<typeof readReceipt>>;
type ConfigurationRead = Extract<Awaited<ReturnType<typeof readConfiguration>>, { status: "read" }>;

function receiptState(read: ReceiptRead): ConfigApplyState {
  if (read.status === "missing") return "absent";
  return read.status === "invalid" ? "unreadable" : read.receipt.state;
}

/** Reads the validated configuration and the selection it implies, without changing either. */
export async function show(projectRoot: string) {
  const read = await readConfiguration(projectRoot);
  return read.status === "read" ? { ...read, selection: selection(read.config) } : read;
}

/** Names every byte the edits would write, from the record and the configuration already read. */
function planFrom(receipt: ReceiptRead, read: ConfigurationRead, edits: Edit[]) {
  const next = operatorConfigSchema.safeParse(change(read.config, edits));
  if (!next.success) {
    return {
      status: "invalid-input" as const,
      issues: next.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const effective = selection(next.data);
  if (
    effective.crew.reasoningEffort.value !== null &&
    effective.crew.host.value === "opencode" &&
    !effective.crew.model.value?.startsWith("openai/")
  ) {
    return {
      status: "invalid-input" as const,
      issues: ["OpenCode needs an explicit OpenAI crew model to apply reasoning effort."],
    };
  }
  const changed = ContentIdentity.of(read.config) !== ContentIdentity.of(next.data);
  const nextText = changed ? `${JSON.stringify(next.data, null, 2)}\n` : read.text;
  const generation =
    receipt.status === "read"
      ? receipt.receipt.state === "pending"
        ? receipt.receipt.generation
        : receipt.receipt.planId
      : null;
  return {
    status: "planned" as const,
    path: CONFIG_PATH,
    previousText: read.text,
    previousIdentity: read.identity,
    nextText,
    nextIdentity: ContentIdentity.ofText(nextText),
    planId: ContentIdentity.of({
      generation,
      previousIdentity: read.identity,
      nextText,
      edits,
    }),
    generation,
    editsIdentity: ContentIdentity.of(edits),
    changed,
    before: read.config,
    after: next.data,
    selection: effective,
  };
}

type Plan = Extract<ReturnType<typeof planFrom>, { status: "planned" }>;

/** Names every byte the proposed change would write, tied to the inspected file identity. */
export async function plan(request: { projectRoot: string; sets: string[]; unsets: string[] }) {
  const parsed = parseEdits(request.sets, request.unsets);
  if ("issues" in parsed) return { status: "invalid-input" as const, issues: parsed.issues };
  const receipt = await readReceipt(request.projectRoot);
  if (receipt.status === "invalid")
    return { status: "recovery-required" as const, detail: receipt.detail };
  const read = await readConfiguration(request.projectRoot);
  if (read.status !== "read") return read;
  return planFrom(receipt, read, parsed.edits);
}

/**
 * Writes the approved file through a temporary copy and reports the write event. The file is
 * renamed only after the copy matches the plan and the configuration still has its inspected
 * identity. A detail means the write could not be confirmed, so the record stays `pending`.
 */
async function writeApproved(
  projectRoot: string,
  approved: Plan,
): Promise<Exclude<ConfigApplyEvent, { kind: "apply" | "recover" }> | { detail: string }> {
  const temporary = `${projectRoot}/${CONFIG_PATH}.${approved.planId}.tmp`;
  try {
    await Bun.write(temporary, approved.nextText);
    if (ContentIdentity.ofText(await Bun.file(temporary).text()) !== approved.nextIdentity)
      return { kind: "write-mismatch" };
    const current = await readConfiguration(projectRoot);
    if (current.status !== "read" || current.identity !== approved.previousIdentity)
      return { kind: "config-stale" as const };
    await rename(temporary, `${projectRoot}/${CONFIG_PATH}`);
    const written = await readConfiguration(projectRoot);
    if (written.status !== "read" || written.identity !== approved.nextIdentity)
      return { detail: "The written configuration could not be verified." };
    return { kind: "write-verified" as const };
  } finally {
    await rm(temporary, { force: true });
  }
}

type Fresh =
  | ReturnType<typeof planFrom>
  | { status: "missing" }
  | { status: "invalid"; issues: string[] };

/** The record and the fresh plan carry the reason of each refusal, in the order of the rules. */
function refusedApply(refused: ConfigApplyRefusal, receipt: ReceiptRead, fresh: Fresh) {
  if (receipt.status === "invalid")
    return { status: "recovery-required" as const, detail: receipt.detail };
  if (refused === "unconfirmed-write" && receipt.status === "read") {
    return {
      status: "recovery-required" as const,
      detail: `Plan ${receipt.receipt.planId} has an unconfirmed write.`,
    };
  }
  if (fresh.status !== "planned") return fresh;
  if (refused === "approval-stale") return { status: "approval-stale" as const, plan: fresh };
  throw new Error(`The config apply refusal ${refused} has no result.`);
}

/** Records the pending write before the file changes, so a recovery can settle it. */
async function writePlanned(projectRoot: string, approved: Plan) {
  const pending = {
    planId: approved.planId,
    generation: approved.generation,
    editsIdentity: approved.editsIdentity,
    previousIdentity: approved.previousIdentity,
    nextIdentity: approved.nextIdentity,
    state: "pending" as const,
  };
  try {
    await writeReceipt(projectRoot, pending);
    const written = await writeApproved(projectRoot, approved);
    if ("detail" in written) return { status: "write-failed" as const, detail: written.detail };
    const decision = ConfigApply.decide("pending", written, {
      receipt: pending,
      identity: null,
      plan: approved,
    });
    if ("refused" in decision || !decision.record)
      throw new Error(`The config apply record has no state after ${written.kind}.`);
    await writeReceipt(projectRoot, { ...pending, state: decision.next });
    if (decision.outcome === "write-failed") {
      return {
        status: "write-failed" as const,
        detail: "The temporary configuration did not match the approved plan.",
      };
    }
    if (decision.outcome === "approval-stale")
      return { status: "approval-stale" as const, plan: approved };
    return { status: "applied" as const, plan: approved };
  } catch (error) {
    return { status: "write-failed" as const, detail: String(error) };
  }
}

/** Applies one approved plan once; an interrupted write is reconciled from its prior intent. */
export async function apply(request: {
  projectRoot: string;
  sets: string[];
  unsets: string[];
  approvedPlanId: string | undefined;
}) {
  const parsed = parseEdits(request.sets, request.unsets);
  if ("issues" in parsed) return { status: "invalid-input" as const, issues: parsed.issues };
  const approvedPlanId = request.approvedPlanId;
  if (approvedPlanId === undefined) {
    const unapproved = await plan(request);
    return unapproved.status === "planned"
      ? { status: "approval-required" as const, plan: unapproved }
      : unapproved;
  }
  return withWriteLock(request.projectRoot, async () => {
    const receipt = await readReceipt(request.projectRoot);
    const read = await readConfiguration(request.projectRoot);
    const fresh: Fresh = read.status === "read" ? planFrom(receipt, read, parsed.edits) : read;
    const decision = ConfigApply.decide(
      receiptState(receipt),
      { kind: "apply", approvedPlanId, editsIdentity: ContentIdentity.of(parsed.edits) },
      {
        receipt: receipt.status === "read" ? receipt.receipt : null,
        identity: read.status === "read" ? read.identity : null,
        plan: fresh.status === "planned" ? fresh : null,
      },
    );
    if ("refused" in decision) return refusedApply(decision.refused, receipt, fresh);
    if (decision.outcome === "repeated") {
      if (decision.record && receipt.status === "read")
        await writeReceipt(request.projectRoot, { ...receipt.receipt, state: decision.next });
      return { status: "unchanged" as const, repeated: true };
    }
    if (fresh.status !== "planned") throw new Error("A config write needs a valid plan.");
    if (decision.outcome === "unchanged")
      return { status: "unchanged" as const, repeated: false, plan: fresh };
    return writePlanned(request.projectRoot, fresh);
  });
}

/** Settles an interrupted apply from the recorded before and after hashes, with no config edit. */
export async function recover(projectRoot: string) {
  return withWriteLock(projectRoot, async () => {
    const receipt = await readReceipt(projectRoot);
    const current = await readConfiguration(projectRoot);
    const decision = ConfigApply.decide(
      receiptState(receipt),
      { kind: "recover" },
      {
        receipt: receipt.status === "read" ? receipt.receipt : null,
        identity: current.status === "read" ? current.identity : null,
        plan: null,
      },
    );
    if ("refused" in decision) {
      const detail =
        receipt.status === "invalid"
          ? receipt.detail
          : decision.refused === "config-unreadable"
            ? "The configuration cannot be read; the pending apply remains open."
            : "The configuration matches neither the before nor the after hash of the pending apply.";
      return { status: "recovery-required" as const, detail };
    }
    if (!decision.record || receipt.status !== "read") return { status: "nothing" as const };
    const state = decision.next;
    try {
      await writeReceipt(projectRoot, { ...receipt.receipt, state });
    } catch (error) {
      return { status: "recovery-required" as const, detail: String(error) };
    }
    return { status: "settled" as const, state, planId: receipt.receipt.planId };
  });
}
