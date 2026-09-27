// Bun has no atomic file rename, directory creation, or removal API.
import { Database } from "bun:sqlite";
import { mkdir, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { AgentSelection } from "../agent-selection/main.ts";
import { ContentIdentity } from "../content-identity/main.ts";
import { operatorConfigSchema } from "./schema.ts";

const CONFIG_PATH = ".operator/config.json";
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

const receiptSchema = z.strictObject({
  planId: z.string(),
  generation: z.string().nullable(),
  editsIdentity: z.string(),
  previousIdentity: z.string(),
  nextIdentity: z.string(),
  state: z.enum(["pending", "complete", "aborted"]),
});

type Config = z.infer<typeof operatorConfigSchema>;
type Edit = { path: string; value: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEdits(sets: string[], unsets: string[]): { edits: Edit[] } | { issues: string[] } {
  const issues: string[] = [];
  const edits: Edit[] = [];
  const seen = new Set<string>();
  for (const [action, values] of [
    ["set", sets],
    ["unset", unsets],
  ] as const) {
    for (const raw of values) {
      const separator = raw.indexOf("=");
      const path = action === "set" ? raw.slice(0, separator) : raw;
      const value = action === "set" ? raw.slice(separator + 1) : null;
      if (action === "unset" && separator !== -1) {
        issues.push(`Unset ${raw} with a path, without =value.`);
      } else if (path === "probe.githubFixture" && action === "set") {
        issues.push("probe.githubFixture can only be unset; set its fields separately.");
      } else if (!editable.some((allowed) => allowed === path)) {
        issues.push(`Unsupported configuration field: ${path || raw}.`);
      } else if (seen.has(path)) {
        issues.push(`Configuration field ${path} was named more than once.`);
      } else if (action === "set" && (separator < 1 || value === "")) {
        issues.push(`Set ${path} with a non-empty path=value argument.`);
      } else {
        seen.add(path);
        edits.push({ path, value });
      }
    }
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

async function writeReceipt(projectRoot: string, receipt: z.infer<typeof receiptSchema>) {
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

export const ConfigurationChange = {
  /** Reads the validated configuration and the selection it implies, without changing either. */
  async show(projectRoot: string) {
    const read = await readConfiguration(projectRoot);
    return read.status === "read" ? { ...read, selection: selection(read.config) } : read;
  },

  /** Names every byte the proposed change would write, tied to the inspected file identity. */
  async plan(request: { projectRoot: string; sets: string[]; unsets: string[] }) {
    const parsed = parseEdits(request.sets, request.unsets);
    if ("issues" in parsed) return { status: "invalid-input" as const, issues: parsed.issues };
    const receipt = await readReceipt(request.projectRoot);
    if (receipt.status === "invalid")
      return { status: "recovery-required" as const, detail: receipt.detail };
    const read = await readConfiguration(request.projectRoot);
    if (read.status !== "read") return read;
    const next = operatorConfigSchema.safeParse(change(read.config, parsed.edits));
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
        edits: parsed.edits,
      }),
      generation,
      editsIdentity: ContentIdentity.of(parsed.edits),
      changed,
      before: read.config,
      after: next.data,
      selection: effective,
    };
  },

  /** Applies one approved plan once; an interrupted write is reconciled from its prior intent. */
  async apply(request: {
    projectRoot: string;
    sets: string[];
    unsets: string[];
    approvedPlanId: string | undefined;
  }) {
    const parsed = parseEdits(request.sets, request.unsets);
    if ("issues" in parsed) return { status: "invalid-input" as const, issues: parsed.issues };
    if (request.approvedPlanId === undefined) {
      const unapproved = await ConfigurationChange.plan(request);
      return unapproved.status === "planned"
        ? { status: "approval-required" as const, plan: unapproved }
        : unapproved;
    }
    return withWriteLock(request.projectRoot, async () => {
      const receipt = await readReceipt(request.projectRoot);
      if (receipt.status === "invalid")
        return { status: "recovery-required" as const, detail: receipt.detail };
      const read = await readConfiguration(request.projectRoot);
      if (read.status !== "read") return read;
      const editsIdentity = ContentIdentity.of(parsed.edits);
      if (
        receipt.status === "read" &&
        receipt.receipt.planId === request.approvedPlanId &&
        receipt.receipt.editsIdentity === editsIdentity &&
        receipt.receipt.nextIdentity === read.identity &&
        receipt.receipt.state !== "aborted"
      ) {
        if (receipt.receipt.state === "pending") {
          await writeReceipt(request.projectRoot, { ...receipt.receipt, state: "complete" });
        }
        return { status: "unchanged" as const, repeated: true };
      }
      if (
        receipt.status === "read" &&
        receipt.receipt.state === "pending" &&
        receipt.receipt.planId !== request.approvedPlanId
      ) {
        return {
          status: "recovery-required" as const,
          detail: `Plan ${receipt.receipt.planId} has an unconfirmed write.`,
        };
      }
      const plan = await ConfigurationChange.plan(request);
      if (plan.status !== "planned") return plan;
      if (request.approvedPlanId !== plan.planId)
        return { status: "approval-stale" as const, plan };
      if (!plan.changed) return { status: "unchanged" as const, repeated: false, plan };

      const nextReceipt = {
        planId: plan.planId,
        generation: plan.generation,
        editsIdentity: plan.editsIdentity,
        previousIdentity: plan.previousIdentity,
        nextIdentity: plan.nextIdentity,
        state: "pending" as const,
      };
      const temporary = `${request.projectRoot}/${CONFIG_PATH}.${plan.planId}.tmp`;
      try {
        await writeReceipt(request.projectRoot, nextReceipt);
        await Bun.write(temporary, plan.nextText);
        if (ContentIdentity.ofText(await Bun.file(temporary).text()) !== plan.nextIdentity) {
          await writeReceipt(request.projectRoot, { ...nextReceipt, state: "aborted" });
          return {
            status: "write-failed" as const,
            detail: "The temporary configuration did not match the approved plan.",
          };
        }
        const current = await readConfiguration(request.projectRoot);
        if (current.status !== "read" || current.identity !== plan.previousIdentity) {
          await writeReceipt(request.projectRoot, { ...nextReceipt, state: "aborted" });
          return { status: "approval-stale" as const, plan };
        }
        await rename(temporary, `${request.projectRoot}/${CONFIG_PATH}`);
        const written = await readConfiguration(request.projectRoot);
        if (written.status !== "read" || written.identity !== plan.nextIdentity) {
          return {
            status: "write-failed" as const,
            detail: "The written configuration could not be verified.",
          };
        }
        await writeReceipt(request.projectRoot, { ...nextReceipt, state: "complete" });
        return { status: "applied" as const, plan };
      } catch (error) {
        return { status: "write-failed" as const, detail: String(error) };
      } finally {
        await rm(temporary, { force: true });
      }
    });
  },

  /** Settles an interrupted apply from the recorded before and after hashes, with no config edit. */
  async recover(projectRoot: string) {
    return withWriteLock(projectRoot, async () => {
      const read = await readReceipt(projectRoot);
      if (read.status === "missing") return { status: "nothing" as const };
      if (read.status === "invalid")
        return { status: "recovery-required" as const, detail: read.detail };
      const receipt = read.receipt;
      if (receipt.state !== "pending") return { status: "nothing" as const };
      const current = await readConfiguration(projectRoot);
      if (current.status !== "read") {
        return {
          status: "recovery-required" as const,
          detail: "The configuration cannot be read; the pending apply remains open.",
        };
      }
      const state =
        current.identity === receipt.nextIdentity
          ? "complete"
          : current.identity === receipt.previousIdentity
            ? "aborted"
            : null;
      if (state === null) {
        return {
          status: "recovery-required" as const,
          detail:
            "The configuration matches neither the before nor the after hash of the pending apply.",
        };
      }
      try {
        await writeReceipt(projectRoot, { ...receipt, state });
      } catch (error) {
        return { status: "recovery-required" as const, detail: String(error) };
      }
      return { status: "settled" as const, state, planId: receipt.planId };
    });
  },
};
