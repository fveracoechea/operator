import { afterEach, describe, expect, test as bunTest } from "bun:test";
// Bun has no file removal API.
import { rm } from "node:fs/promises";
import { runJson, runOperator, workspaces } from "./workspace-fixture.ts";

// Config tests run multiple CLI processes against a project fixture.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

describe("operator config", () => {
  test("shows validated settings and the effective selection without editing the file", async () => {
    const workspace = await fixtures.make({
      config: { operator: { host: "claude-code" }, crew: { reasoningEffort: "medium" } },
    });
    const file = Bun.file(`${workspace.repo}/.operator/config.json`);
    const before = await file.text();

    const shown = await runJson(workspace, ["config", "show"]);

    expect(shown.exitCode).toBe(0);
    expect(shown.json.data.config.crew.reasoningEffort).toBe("medium");
    expect(shown.json.data.selection.crew.host).toEqual({
      value: "claude-code",
      source: "operator-host",
    });
    expect(shown.json.data.selection.crew.reasoningEffort).toEqual({
      value: "medium",
      source: "project-configuration",
    });
    expect(await file.text()).toBe(before);
  });

  test("plans exact changes, then applies the approved file once", async () => {
    const workspace = await fixtures.make({ config: { operator: {}, crew: {} } });
    const file = Bun.file(`${workspace.repo}/.operator/config.json`);
    const before = await file.text();
    const edits = [
      "--set",
      "crew.reasoningEffort=medium",
      "--set",
      "crew.model=openai/gpt-6-sol",
      "--set",
      "crew.host=opencode",
      "--set",
      "crew.maxActiveAgents=2",
      "--set",
      "probe.githubFixture.repository=owner/repo",
      "--set",
      "probe.githubFixture.issue=50",
      "--set",
      "probe.githubFixture.mapIssue=51",
    ];

    const plan = await runJson(workspace, ["config", "plan", ...edits]);
    expect(plan.exitCode).toBe(0);
    expect(plan.json.data.previousText).toBe(before);
    expect(plan.json.data.after.crew).toEqual({
      host: "opencode",
      model: "openai/gpt-6-sol",
      reasoningEffort: "medium",
      maxActiveAgents: 2,
    });
    expect(plan.json.data.after.probe.githubFixture).toEqual({
      repository: "owner/repo",
      issue: 50,
      mapIssue: 51,
    });
    expect(plan.json.data.selection.crew.reasoningEffort).toEqual({
      value: "medium",
      source: "project-configuration",
    });
    expect(await file.text()).toBe(before);

    const reordered = await runJson(workspace, [
      "config",
      "plan",
      ...edits.slice(4),
      ...edits.slice(0, 4),
    ]);
    expect(reordered.json.data.planId).toBe(plan.json.data.planId);
    const missing = await runJson(workspace, ["config", "apply", ...edits]);
    expect(missing.json.reason).toBe("approval_required");
    expect(missing.stdout).toStartWith(
      `{"schemaVersion":1,"outcome":"missing-condition","reason":"approval_required","blockers":[{"reason":"approval_required","approvedPlanId":null,"currentPlanId":"${plan.json.data.planId}"}],"operation":"config_apply","data":{"path":`,
    );
    const planText = await runOperator(workspace, ["config", "plan", ...edits]);
    const missingText = await runOperator(workspace, ["config", "apply", ...edits]);
    expect(missingText.stdout).toBe(
      `Approval is required. Nothing was written.\n${planText.stdout}`,
    );
    expect(await file.text()).toBe(before);

    const args = ["config", "apply", ...edits, "--approved-plan", plan.json.data.planId];
    const applied = await runJson(workspace, args);
    expect(applied.json.reason).toBe("config_applied");
    expect(await file.text()).toBe(plan.json.data.nextText);
    const readiness = await runJson(workspace, ["setup", "readiness", "--opencode"]);
    expect(readiness.json.data.selection.crew.reasoningEffort).toBe("medium");
    expect(readiness.json.data.fixture).toEqual({
      repository: "owner/repo",
      issue: 50,
      mapIssue: 51,
    });
    const owned = await runJson(workspace, [
      "crew",
      "own",
      "--request",
      crypto.randomUUID(),
      "--owner-label",
      "config-test",
    ]);
    expect(owned.json.reason).toBe("ownership_acquired");
    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(frontier.json.data.capacity.limit).toBe(2);

    const repeated = await runJson(workspace, args);
    expect(repeated.json.reason).toBe("config_unchanged");
    expect(repeated.json.data.repeated).toBe(true);
    expect(await file.text()).toBe(plan.json.data.nextText);
  });

  test("rejects stale approval and does not replace a changed file", async () => {
    const workspace = await fixtures.make();
    const file = Bun.file(`${workspace.repo}/.operator/config.json`);
    const edits = ["--set", "crew.reasoningEffort=medium"];
    const plan = await runJson(workspace, ["config", "plan", ...edits]);
    const changed = '{"crew":{"host":"opencode","model":"openai/gpt-6-sol"}}\n';
    await Bun.write(file, changed);

    const applied = await runJson(workspace, [
      "config",
      "apply",
      ...edits,
      "--approved-plan",
      plan.json.data.planId,
    ]);

    expect(applied.exitCode).toBe(4);
    expect(applied.json.reason).toBe("approval_stale");
    expect(applied.stdout).toStartWith(
      `{"schemaVersion":1,"outcome":"conflict","reason":"approval_stale","blockers":[{"reason":"approval_stale","approvedPlanId":"${plan.json.data.planId}","currentPlanId":"${applied.json.data.planId}"}],"operation":"config_apply","data":{"path":`,
    );
    const planText = await runOperator(workspace, ["config", "plan", ...edits]);
    const staleText = await runOperator(workspace, [
      "config",
      "apply",
      ...edits,
      "--approved-plan",
      plan.json.data.planId,
    ]);
    expect(staleText.stdout).toBe(
      `The file or proposed edit changed. Nothing was written.\n${planText.stdout}`,
    );
    expect(await file.text()).toBe(changed);
  });

  test("serializes competing approved edits to the same file", async () => {
    const workspace = await fixtures.make();
    const low = ["--set", "crew.reasoningEffort=low"];
    const high = ["--set", "crew.reasoningEffort=high"];
    const lowPlan = await runJson(workspace, ["config", "plan", ...low]);
    const highPlan = await runJson(workspace, ["config", "plan", ...high]);

    const results = await Promise.all([
      runJson(workspace, ["config", "apply", ...low, "--approved-plan", lowPlan.json.data.planId]),
      runJson(workspace, [
        "config",
        "apply",
        ...high,
        "--approved-plan",
        highPlan.json.data.planId,
      ]),
    ]);
    expect(results.map((result) => result.json.reason).toSorted()).toEqual([
      "approval_stale",
      "config_applied",
    ]);
    const winner = results.find((result) => result.json.reason === "config_applied");
    expect(await Bun.file(`${workspace.repo}/.operator/config.json`).text()).toBe(
      winner?.json.data.nextText,
    );
    const receipt = await Bun.file(`${workspace.repo}/.operator/local/config-apply.json`).json();
    expect(receipt.planId).toBe(winner?.json.data.planId);
  });

  test("recovers a written file with a pending receipt without writing it again", async () => {
    const workspace = await fixtures.make();
    const edits = ["--set", "crew.reasoningEffort=high"];
    const plan = await runJson(workspace, ["config", "plan", ...edits]);
    await Bun.write(
      `${workspace.repo}/.operator/local/config-apply.json`,
      JSON.stringify({
        planId: plan.json.data.planId,
        generation: null,
        editsIdentity: plan.json.data.editsIdentity,
        previousIdentity: plan.json.data.previousIdentity,
        nextIdentity: plan.json.data.nextIdentity,
        state: "pending",
      }),
      { createPath: true },
    );
    await Bun.write(`${workspace.repo}/.operator/config.json`, plan.json.data.nextText);

    const result = await runJson(workspace, [
      "config",
      "apply",
      ...edits,
      "--approved-plan",
      plan.json.data.planId,
    ]);

    expect(result.json.reason).toBe("config_unchanged");
    expect(result.json.data.repeated).toBe(true);
    expect(
      (await Bun.file(`${workspace.repo}/.operator/local/config-apply.json`).json()).state,
    ).toBe("complete");
  });

  test("settles an interrupted apply that left the old file in place", async () => {
    const workspace = await fixtures.make();
    const file = Bun.file(`${workspace.repo}/.operator/config.json`);
    const before = await file.text();
    const edits = ["--set", "crew.reasoningEffort=high"];
    const plan = await runJson(workspace, ["config", "plan", ...edits]);
    await Bun.write(
      `${workspace.repo}/.operator/local/config-apply.json`,
      JSON.stringify({
        planId: plan.json.data.planId,
        generation: null,
        editsIdentity: plan.json.data.editsIdentity,
        previousIdentity: plan.json.data.previousIdentity,
        nextIdentity: plan.json.data.nextIdentity,
        state: "pending",
      }),
      { createPath: true },
    );

    const recovered = await runJson(workspace, ["config", "recover"]);
    expect(recovered.json.reason).toBe("config_recovered");
    expect(recovered.json.data.state).toBe("aborted");
    expect(await file.text()).toBe(before);
    const next = await runJson(workspace, ["config", "plan", ...edits]);
    expect(next.json.data.planId).not.toBe(plan.json.data.planId);
  });

  test("keeps an unfamiliar file when recovery cannot prove which write landed", async () => {
    const workspace = await fixtures.make();
    const edits = ["--set", "crew.reasoningEffort=high"];
    const plan = await runJson(workspace, ["config", "plan", ...edits]);
    await Bun.write(
      `${workspace.repo}/.operator/local/config-apply.json`,
      JSON.stringify({
        planId: plan.json.data.planId,
        generation: null,
        editsIdentity: plan.json.data.editsIdentity,
        previousIdentity: plan.json.data.previousIdentity,
        nextIdentity: plan.json.data.nextIdentity,
        state: "pending",
      }),
      { createPath: true },
    );
    const unfamiliar = '{"crew":{"host":"claude-code","reasoningEffort":"medium"}}\n';
    await Bun.write(`${workspace.repo}/.operator/config.json`, unfamiliar);

    const recovered = await runJson(workspace, ["config", "recover"]);
    expect(recovered.json.reason).toBe("config_recovery_required");
    expect(await Bun.file(`${workspace.repo}/.operator/config.json`).text()).toBe(unfamiliar);
  });

  test("requires a new approval if someone restores the earlier file after apply", async () => {
    const workspace = await fixtures.make();
    const file = Bun.file(`${workspace.repo}/.operator/config.json`);
    const before = await file.text();
    const edits = ["--set", "crew.reasoningEffort=medium"];
    const first = await runJson(workspace, ["config", "plan", ...edits]);
    const approved = ["config", "apply", ...edits, "--approved-plan", first.json.data.planId];
    expect((await runJson(workspace, approved)).json.reason).toBe("config_applied");

    await Bun.write(file, before);
    const stale = await runJson(workspace, approved);
    expect(stale.json.reason).toBe("approval_stale");
    expect(await file.text()).toBe(before);
    const second = await runJson(workspace, ["config", "plan", ...edits]);
    expect(second.json.data.planId).not.toBe(first.json.data.planId);
    expect(
      (
        await runJson(workspace, [
          "config",
          "apply",
          ...edits,
          "--approved-plan",
          second.json.data.planId,
        ])
      ).json.reason,
    ).toBe("config_applied");
  });

  test("changes host and model, then unsets fields and the probe fixture", async () => {
    const workspace = await fixtures.make({
      config: {
        operator: { host: "opencode", model: "openai/gpt-6-sol" },
        crew: { host: "opencode", model: "openai/gpt-6-sol", reasoningEffort: "medium" },
        probe: { githubFixture: { repository: "owner/repo", issue: 50 } },
      },
    });
    const edits = [
      "--set",
      "operator.host=claude-code",
      "--set",
      "operator.model=sonnet",
      "--unset",
      "crew.reasoningEffort",
      "--unset",
      "probe.githubFixture",
    ];
    const planned = await runJson(workspace, ["config", "plan", ...edits]);
    expect(planned.json.data.after.operator).toEqual({ host: "claude-code", model: "sonnet" });
    expect(planned.json.data.after.crew.reasoningEffort).toBeUndefined();
    expect(planned.json.data.after.probe).toEqual({});
    const applied = await runJson(workspace, [
      "config",
      "apply",
      ...edits,
      "--approved-plan",
      planned.json.data.planId,
    ]);
    expect(applied.json.reason).toBe("config_applied");
  });

  test("refuses invalid configuration, invalid values, and unknown fields", async () => {
    const workspace = await fixtures.make({ config: { crew: { host: "opencode" } } });
    for (const field of [
      "crew.reasoningEffort=fast",
      "crew.host=cursor",
      "crew.maxActiveAgents=0",
      "crew.maxActiveAgents=nan",
      "probe.githubFixture.issue=0",
      "random.field=value",
    ]) {
      const result = await runJson(workspace, ["config", "plan", "--set", field]);
      expect(result.exitCode).toBe(2);
      expect(result.json.reason).toBe("invalid_config_change");
    }
    await Bun.write(`${workspace.repo}/.operator/config.json`, '{"crew":{"unknown":true}}\n');
    expect((await runJson(workspace, ["config", "show"])).json.reason).toBe(
      "invalid_configuration",
    );
    expect(
      (await runJson(workspace, ["config", "plan", "--set", "crew.reasoningEffort=medium"])).json
        .reason,
    ).toBe("invalid_configuration");
  });

  test("refuses a missing configuration instead of creating one", async () => {
    const workspace = await fixtures.make();
    await rm(`${workspace.repo}/.operator/config.json`);
    const shown = await runJson(workspace, ["config", "show"]);
    expect(shown.json.reason).toBe("not_configured");
    const planned = await runJson(workspace, ["config", "plan", "--set", "crew.host=opencode"]);
    expect(planned.json.reason).toBe("not_configured");
    expect(await Bun.file(`${workspace.repo}/.operator/config.json`).exists()).toBe(false);
  });

  test("reports an effort that the selected OpenCode model cannot apply", async () => {
    const workspace = await fixtures.make({
      config: { crew: { host: "opencode", model: "anthropic/sonnet" } },
    });
    const result = await runJson(workspace, [
      "config",
      "plan",
      "--set",
      "crew.reasoningEffort=medium",
    ]);
    expect(result.json.reason).toBe("invalid_config_change");
    expect(result.json.blockers[0].issues).toContain(
      "OpenCode needs an explicit OpenAI crew model to apply reasoning effort.",
    );
  });

  test("does not accept config edit flags on another command", async () => {
    const workspace = await fixtures.make();
    const result = await runOperator(workspace, [
      "work",
      "frontier",
      "--set",
      "crew.reasoningEffort=medium",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).reason).toBe("invalid_arguments");
  });
});
