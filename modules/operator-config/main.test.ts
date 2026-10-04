import { afterEach, describe, expect, test } from "bun:test";
// Bun has no temporary directory API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OperatorConfig } from "./main.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(config: unknown = { operator: {}, crew: {} }): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/operator-config-`);
  roots.push(root);
  await Bun.write(`${root}/.operator/config.json`, `${JSON.stringify(config)}\n`);
  return root;
}

async function planned(root: string, sets: string[]) {
  const plan = await OperatorConfig.planChange({ projectRoot: root, sets, unsets: [] });
  if (plan.status !== "planned") throw new Error(`Expected a plan, got ${plan.status}`);
  return plan;
}

async function writeReceipt(root: string, receipt: Record<string, unknown>): Promise<void> {
  await Bun.write(`${root}/.operator/local/config-apply.json`, JSON.stringify(receipt));
}

async function pendingReceipt(root: string, plan: Awaited<ReturnType<typeof planned>>) {
  await writeReceipt(root, {
    planId: plan.planId,
    generation: plan.generation,
    editsIdentity: plan.editsIdentity,
    previousIdentity: plan.previousIdentity,
    nextIdentity: plan.nextIdentity,
    state: "pending",
  });
}

describe("Operator configuration", () => {
  test("accepts an empty selection", () => {
    expect(OperatorConfig.parse({ operator: {}, crew: {} })).toEqual({
      ok: true,
      config: { operator: {}, crew: {} },
    });
  });

  test("accepts the generated default file", () => {
    const parsed = OperatorConfig.parse(JSON.parse(OperatorConfig.defaultFileText()));

    expect(parsed.ok).toBe(true);
  });

  test("validates the crew reasoning effort", () => {
    expect(OperatorConfig.parse({ crew: { reasoningEffort: "medium" } })).toEqual({
      ok: true,
      config: { crew: { reasoningEffort: "medium" } },
    });
    expect(OperatorConfig.parse({ crew: { reasoningEffort: "extreme" } }).ok).toBe(false);
    const schema = JSON.parse(OperatorConfig.jsonSchemaText());
    expect(schema.properties.crew.properties.reasoningEffort.enum).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("rejects an unknown field", () => {
    expect(OperatorConfig.parse({ operatr: {} })).toEqual({
      ok: false,
      issues: ['Unrecognized key: "operatr"'],
    });
  });

  test("rejects an unknown host", () => {
    expect(OperatorConfig.parse({ operator: { host: "cursor" } })).toEqual({
      ok: false,
      issues: ['operator.host: Invalid option: expected one of "opencode"|"claude-code"'],
    });
  });

  test("names the field of every reported issue", () => {
    const parsed = OperatorConfig.parse({ crew: { model: "" } });

    expect(parsed).toEqual({
      ok: false,
      issues: ["crew.model: Too small: expected string to have >=1 characters"],
    });
  });

  test("generates an editor schema that rejects the same unknown field", () => {
    const schema = JSON.parse(OperatorConfig.jsonSchemaText());

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.operator.properties.host.enum).toEqual(["opencode", "claude-code"]);
  });

  test("points the default file at the generated schema beside it", () => {
    expect(JSON.parse(OperatorConfig.defaultFileText()).$schema).toBe("./config.schema.json");
  });
});

describe("Operator configuration change", () => {
  test("names each refused edit in argument order, sets before unsets", async () => {
    const root = await project();
    const issues = async (sets: string[], unsets: string[]) => {
      const plan = await OperatorConfig.planChange({ projectRoot: root, sets, unsets });
      return plan.status === "invalid-input" ? plan.issues : plan.status;
    };

    expect(await issues([], [])).toEqual(["Name at least one --set or --unset field."]);
    expect(
      await issues(
        ["crew.host", "=x", "probe.githubFixture=x", "crew.model=", "crew.model=a", "crew.model=b"],
        ["crew.host=x", "crew.model", "random.field"],
      ),
    ).toEqual([
      "Unsupported configuration field: crew.hos.",
      "Unsupported configuration field: =x.",
      "probe.githubFixture can only be unset; set its fields separately.",
      "Set crew.model with a non-empty path=value argument.",
      "Configuration field crew.model was named more than once.",
      "Unset crew.host=x with a path, without =value.",
      "Configuration field crew.model was named more than once.",
      "Unsupported configuration field: random.field.",
    ]);
    expect(await issues(["probe.githubFixture.issue=4"], ["probe.githubFixture"])).toEqual([
      "Set or unset fixture fields, or unset the whole fixture, not both.",
    ]);
    expect(await issues(["crew.model=b", "crew.host=opencode"], [])).toBe("planned");
  });

  test("refuses an approved apply while another plan has an unconfirmed write", async () => {
    const root = await project();
    const other = await planned(root, ["crew.model=other"]);
    await pendingReceipt(root, other);
    const plan = await planned(root, ["crew.model=mine"]);

    expect(
      await OperatorConfig.applyChange({
        projectRoot: root,
        sets: ["crew.model=mine"],
        unsets: [],
        approvedPlanId: plan.planId,
      }),
    ).toEqual({
      status: "recovery-required",
      detail: `Plan ${other.planId} has an unconfirmed write.`,
    });
  });

  test("keeps a pending apply open when recovery cannot read or prove the configuration", async () => {
    const root = await project();
    const plan = await planned(root, ["crew.model=next"]);
    await pendingReceipt(root, plan);

    await Bun.write(`${root}/.operator/config.json`, '{"crew":{"model":"unfamiliar"}}\n');
    expect(await OperatorConfig.recoverChange(root)).toEqual({
      status: "recovery-required",
      detail:
        "The configuration matches neither the before nor the after hash of the pending apply.",
    });

    await Bun.write(`${root}/.operator/config.json`, "{");
    expect(await OperatorConfig.recoverChange(root)).toEqual({
      status: "recovery-required",
      detail: "The configuration cannot be read; the pending apply remains open.",
    });
  });

  test("asks for recovery when the apply record cannot be read", async () => {
    const root = await project();
    await Bun.write(`${root}/.operator/local/config-apply.json`, '{"state":"done"}');
    const request = { projectRoot: root, sets: ["crew.model=a"], unsets: [] };

    for (const result of [
      await OperatorConfig.planChange(request),
      await OperatorConfig.applyChange({ ...request, approvedPlanId: "any" }),
      await OperatorConfig.recoverChange(root),
    ]) {
      expect(result.status).toBe("recovery-required");
    }
  });

  test("settles nothing without a pending apply", async () => {
    const root = await project();
    expect(await OperatorConfig.recoverChange(root)).toEqual({ status: "nothing" });
    const plan = await planned(root, ["crew.model=a"]);
    await pendingReceipt(root, plan);
    const receipt = await Bun.file(`${root}/.operator/local/config-apply.json`).json();
    for (const state of ["complete", "aborted"]) {
      await writeReceipt(root, { ...receipt, state });
      expect(await OperatorConfig.recoverChange(root)).toEqual({ status: "nothing" });
    }
  });

  test("writes nothing when the approved plan does not change the file", async () => {
    const root = await project({ operator: {}, crew: { model: "a" } });
    const plan = await planned(root, ["crew.model=a"]);

    const result = await OperatorConfig.applyChange({
      projectRoot: root,
      sets: ["crew.model=a"],
      unsets: [],
      approvedPlanId: plan.planId,
    });

    expect(result).toEqual({ status: "unchanged", repeated: false, plan });
    expect(await Bun.file(`${root}/.operator/local/config-apply.json`).exists()).toBe(false);
  });
});

describe("Config apply machine", () => {
  const receipt = {
    planId: "plan",
    generation: null,
    editsIdentity: "edits",
    previousIdentity: "before",
    nextIdentity: "after",
    state: "pending" as const,
  };
  const apply = { kind: "apply" as const, approvedPlanId: "plan", editsIdentity: "edits" };
  const fresh = { planId: "plan", changed: true };

  test("repeats an approved write only while the file is the one it wrote", () => {
    const facts = { receipt, identity: "after", plan: fresh };
    expect(OperatorConfig.decideApply("pending", apply, facts)).toEqual({
      next: "complete",
      record: true,
      outcome: "repeated",
    });
    expect(
      OperatorConfig.decideApply("complete", apply, {
        ...facts,
        receipt: { ...receipt, state: "complete" },
      }),
    ).toEqual({ next: "complete", record: false, outcome: "repeated" });
    expect(
      OperatorConfig.decideApply("aborted", apply, {
        ...facts,
        receipt: { ...receipt, state: "aborted" },
      }),
    ).toEqual({ next: "pending", record: true, outcome: "write" });
    expect(OperatorConfig.decideApply("complete", apply, { ...facts, identity: "before" })).toEqual(
      {
        next: "pending",
        record: true,
        outcome: "write",
      },
    );
  });

  test("refuses an apply in the order of its rules", () => {
    const facts = { receipt, identity: "before", plan: fresh };
    expect(OperatorConfig.decideApply("unreadable", apply, { ...facts, identity: null })).toEqual({
      refused: "receipt-unreadable",
    });
    expect(OperatorConfig.decideApply("absent", apply, { ...facts, identity: null })).toEqual({
      refused: "config-unreadable",
    });
    expect(
      OperatorConfig.decideApply("pending", apply, {
        ...facts,
        receipt: { ...receipt, planId: "other" },
      }),
    ).toEqual({ refused: "unconfirmed-write" });
    expect(OperatorConfig.decideApply("absent", apply, { ...facts, plan: null })).toEqual({
      refused: "plan-invalid",
    });
    expect(
      OperatorConfig.decideApply("absent", apply, {
        ...facts,
        plan: { planId: "new", changed: true },
      }),
    ).toEqual({ refused: "approval-stale" });
    expect(
      OperatorConfig.decideApply("absent", apply, { ...facts, plan: { ...fresh, changed: false } }),
    ).toEqual({ next: "absent", record: false, outcome: "unchanged" });
  });

  test("settles a pending write from the write event", () => {
    const facts = { receipt, identity: null, plan: fresh };
    expect(OperatorConfig.decideApply("pending", { kind: "write-verified" }, facts)).toEqual({
      next: "complete",
      record: true,
      outcome: "applied",
    });
    expect(OperatorConfig.decideApply("pending", { kind: "write-mismatch" }, facts)).toEqual({
      next: "aborted",
      record: true,
      outcome: "write-failed",
    });
    expect(OperatorConfig.decideApply("pending", { kind: "config-stale" }, facts)).toEqual({
      next: "aborted",
      record: true,
      outcome: "approval-stale",
    });
  });

  test("recovers a pending write only from a hash it recorded", () => {
    const recover = { kind: "recover" as const };
    const facts = { receipt, identity: "after", plan: null };
    for (const state of ["absent", "complete", "aborted"] as const) {
      expect(OperatorConfig.decideApply(state, recover, facts)).toEqual({
        next: state,
        record: false,
        outcome: "nothing",
      });
    }
    expect(OperatorConfig.decideApply("unreadable", recover, facts)).toEqual({
      refused: "receipt-unreadable",
    });
    expect(OperatorConfig.decideApply("pending", recover, facts)).toEqual({
      next: "complete",
      record: true,
      outcome: "settled",
    });
    expect(
      OperatorConfig.decideApply("pending", recover, { ...facts, identity: "before" }),
    ).toEqual({
      next: "aborted",
      record: true,
      outcome: "settled",
    });
    expect(OperatorConfig.decideApply("pending", recover, { ...facts, identity: "other" })).toEqual(
      {
        refused: "unproven-write",
      },
    );
    expect(OperatorConfig.decideApply("pending", recover, { ...facts, identity: null })).toEqual({
      refused: "config-unreadable",
    });
  });
});
