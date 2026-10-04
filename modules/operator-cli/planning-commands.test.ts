import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no directory listing API.
import { readdir } from "node:fs/promises";
import { ContentIdentity } from "../content-identity/main.ts";
import { type FixtureItem, registerSource, workspaceTarget } from "./source-fixture.ts";
import { githubState, makeTrackerWorkspace, recordStep, TICKET } from "./tracker-fixture.ts";
import {
  githubCalls,
  nextActions,
  ownCrew,
  requestId as request,
  runJson,
  type Workspace,
  workspaces,
} from "./workspace-fixture.ts";

// Planning tests run separate CLI processes against one fixture repository.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

type ItemSpec = {
  key: string;
  kind?: "production" | "planning";
  wayfinderType?: "research" | "grilling" | "prototype" | "task";
  dependsOn?: string[];
};

function item(spec: ItemSpec): FixtureItem {
  return {
    key: spec.key,
    title: `Item ${spec.key}`,
    kind: spec.wayfinderType === undefined ? (spec.kind ?? "production") : undefined,
    wayfinderType: spec.wayfinderType,
    body: `The approved scope of item ${spec.key}. Keep the rollout behind a flag.`,
    dependsOn: (spec.dependsOn ?? []).map((key) => ({ key })),
  };
}

async function writeJson(workspace: Workspace, value: unknown): Promise<string> {
  const path = `${workspace.root}/input-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(value));
  return path;
}

async function register(
  workspace: Workspace,
  ownerToken: string,
  source: { sourceKind: "wayfinder" | "specification"; items: ItemSpec[] },
): Promise<Map<string, string>> {
  const registered = await registerSource(workspaceTarget(workspace), ownerToken, {
    sourceKind: source.sourceKind,
    parent: 1,
    items: source.items.map(item),
  });
  return registered.keys;
}

async function accept(
  workspace: Workspace,
  ownerToken: string,
  options: { assignmentId: string; revision: number; record?: unknown },
) {
  return runJson(workspace, [
    "work",
    "accept",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    String(options.revision),
    ...(options.record === undefined
      ? []
      : ["--input", await writeJson(workspace, options.record)]),
  ]);
}

const READING = {
  summary: "Roll out behind a flag.",
  directives: ["Guard the new path with the rollout flag."],
  appliesTo: ["The rollout of the new path."],
};

function humanAnswer(question = "Do we roll out behind a flag?") {
  return {
    question,
    escalationTriggers: [],
    authority: "human-answer",
    exactText: "Yes, behind a flag.",
    interpretation: READING,
  };
}

function operatorDecision() {
  return {
    question: "Which library parses the feed?",
    escalationTriggers: [],
    authority: "operator-decision",
    interpretation: READING,
  };
}

function record(entries: unknown[], artifacts: unknown[] = []) {
  return { entries, artifacts };
}

/** Invalidates one accepted planning decision, and returns the revision it moved to. */
async function invalidate(
  workspace: Workspace,
  ownerToken: string,
  options: { assignmentId: string; revision: number },
): Promise<number> {
  const invalidated = await runJson(workspace, [
    "work",
    "invalidate",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    String(options.revision),
    "--input",
    await writeJson(workspace, {
      summary: "The decision was wrong.",
      evidence: "A later read showed it.",
      foundBy: "the Operator",
    }),
  ]);
  expect(invalidated.json.reason).toBe("result_invalidated");
  return invalidated.json.data.revision;
}

async function storedFiles(workspace: Workspace, folder: string): Promise<string[]> {
  return readdir(`${workspace.repo}/.operator/local/${folder}`).catch(() => []);
}

describe("operator work accept of planning work", () => {
  test("refuses an acceptance with no planning record and records nothing", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [
        { key: "1", wayfinderType: "research" },
        { key: "2", wayfinderType: "task", dependsOn: ["1"] },
      ],
    });

    const refused = await accept(workspace, ownerToken, {
      assignmentId: ids.get("1") ?? "",
      revision: 1,
    });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("planning_record_required");
    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(frontier.json.data.dispatchable).toEqual([]);
  });

  test("refuses a record with no entry", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [{ key: "1", wayfinderType: "research" }],
    });

    // A planning item that turns out not to be needed records one entry that says so.
    const refused = await accept(workspace, ownerToken, {
      assignmentId: ids.get("1") ?? "",
      revision: 1,
      record: record([]),
    });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("invalid_planning_record");
  });

  test("refuses a record for work that is not planning work", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "specification",
      items: [{ key: "1", kind: "production" }],
    });

    const refused = await accept(workspace, ownerToken, {
      assignmentId: ids.get("1") ?? "",
      revision: 1,
      record: record([humanAnswer()]),
    });

    expect(refused.json.reason).toBe("planning_record_not_expected");
  });

  test("refuses planning work whose own dependencies are not accepted", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [
        { key: "1", wayfinderType: "research" },
        { key: "2", wayfinderType: "grilling", dependsOn: ["1"] },
      ],
    });

    const refused = await accept(workspace, ownerToken, {
      assignmentId: ids.get("2") ?? "",
      revision: 1,
      record: record([humanAnswer()]),
    });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("dependency_pending");
    expect(refused.json.blockers[0].dependencies).toEqual([
      { assignmentId: ids.get("1"), state: "registered" },
    ]);
  });

  test("refuses invalidated planning work again while its own dependency is invalidated", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [
        { key: "1", wayfinderType: "research" },
        { key: "2", wayfinderType: "grilling", dependsOn: ["1"] },
      ],
    });
    const dependency = ids.get("1") ?? "";
    const decision = ids.get("2") ?? "";
    const first = await accept(workspace, ownerToken, {
      assignmentId: dependency,
      revision: 1,
      record: record([operatorDecision()]),
    });
    const second = await accept(workspace, ownerToken, {
      assignmentId: decision,
      revision: 1,
      record: record([humanAnswer()]),
    });
    const revision = await invalidate(workspace, ownerToken, {
      assignmentId: decision,
      revision: second.json.data.revision,
    });
    await invalidate(workspace, ownerToken, {
      assignmentId: dependency,
      revision: first.json.data.revision,
    });

    const refused = await accept(workspace, ownerToken, {
      assignmentId: decision,
      revision,
      record: record([humanAnswer()]),
    });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("dependency_pending");
    expect(refused.json.blockers[0].dependencies).toEqual([
      { assignmentId: dependency, state: "invalidated" },
    ]);
  });

  test("refuses an Operator decision in a grilling, a prototype, and declared planning work", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const wayfinder = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [
        { key: "g", wayfinderType: "grilling" },
        { key: "p", wayfinderType: "prototype" },
      ],
    });

    for (const [key, type] of [
      ["g", "grilling"],
      ["p", "prototype"],
    ] as const) {
      const refused = await accept(workspace, ownerToken, {
        assignmentId: wayfinder.get(key) ?? "",
        revision: 1,
        record: record([humanAnswer(), operatorDecision()]),
      });
      expect(refused.exitCode).toBe(3);
      expect(refused.json.reason).toBe("operator_decision_not_allowed");
      expect(refused.json.blockers[0]).toMatchObject({ entry: 2, planningType: type });
    }
  });

  test("refuses an Operator decision in planning work of a specification", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "specification",
      items: [{ key: "d", kind: "planning" }],
    });

    const refused = await accept(workspace, ownerToken, {
      assignmentId: ids.get("d") ?? "",
      revision: 1,
      record: record([operatorDecision()]),
    });

    expect(refused.json.reason).toBe("operator_decision_not_allowed");
    expect(refused.json.blockers[0]).toMatchObject({ entry: 1, planningType: null });
  });

  test("records an Operator decision in a research record", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [
        { key: "r", wayfinderType: "research" },
        { key: "t", wayfinderType: "task", dependsOn: ["r"] },
      ],
    });

    const accepted = await accept(workspace, ownerToken, {
      assignmentId: ids.get("r") ?? "",
      revision: 1,
      record: record([operatorDecision()]),
    });

    expect(accepted.exitCode).toBe(0);
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.planningRecordId).toEqual(expect.any(String));
    const frontier = await runJson(workspace, ["work", "frontier"]);
    expect(
      frontier.json.data.dispatchable.map((one: { assignmentId: string }) => one.assignmentId),
    ).toEqual([ids.get("t")]);
  });

  test("refuses a requirement that settles an ambiguity or a conflict", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [{ key: "g", wayfinderType: "grilling" }],
    });
    const assignmentId = ids.get("g") ?? "";

    for (const trigger of ["ambiguity", "conflicting-requirements"]) {
      const refused = await accept(workspace, ownerToken, {
        assignmentId,
        revision: 1,
        record: record([
          {
            question: "Do we roll out behind a flag?",
            escalationTriggers: ["scope", trigger],
            authority: "requirement",
            exactText: "Keep the rollout behind a flag.",
            source: { kind: "approved-scope", assignmentId },
            interpretation: READING,
          },
        ]),
      });

      expect(refused.exitCode).toBe(3);
      expect(refused.json.reason).toBe("escalation_required");
      expect(refused.json.blockers[0]).toMatchObject({
        entry: 1,
        authority: "requirement",
        escalationTriggers: [trigger],
      });
    }
  });

  test("checks the quote of a requirement against a stored copy of its source", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [{ key: "g", wayfinderType: "grilling" }],
    });
    const assignmentId = ids.get("g") ?? "";
    // The source lives outside the checkout, as a file only the user keeps does.
    const sourcePath = `${workspace.root}/OPINIONS.md`;
    await Bun.write(sourcePath, "# Opinions\r\n\r\nShip behind a flag.\r\n");
    const requirement = (exactText: string) => ({
      question: "Do we roll out behind a flag?",
      escalationTriggers: ["visible-behavior"],
      authority: "requirement",
      exactText,
      source: { kind: "copy", path: sourcePath },
      interpretation: READING,
    });

    // Registration can store the text of its own source before the acceptance.
    const before = await storedFiles(workspace, "sources");
    const refused = await accept(workspace, ownerToken, {
      assignmentId,
      revision: 1,
      record: record([humanAnswer(), requirement("Ship it behind a flag.")]),
    });
    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("quote_not_in_source");
    expect(refused.json.blockers[0].entry).toBe(2);
    // A refused quote leaves no copy behind.
    expect(await storedFiles(workspace, "sources")).toEqual(before);

    const accepted = await accept(workspace, ownerToken, {
      assignmentId,
      revision: 1,
      record: record([humanAnswer(), requirement("# Opinions\n\nShip behind a flag.")]),
    });
    expect(accepted.json.reason).toBe("assignment_accepted");
    const revision = ContentIdentity.ofBytes(
      new Uint8Array(await Bun.file(sourcePath).arrayBuffer()),
    );
    expect((await storedFiles(workspace, "sources")).toSorted()).toEqual(
      [...before, revision].toSorted(),
    );
  });

  test("stores each artifact under its content identity and refuses one that changed", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [{ key: "g", wayfinderType: "grilling" }],
    });
    const artifactPath = `${workspace.root}/resolution.md`;
    const text = "## Rejected\n\nA flag per user.\n";
    await Bun.write(artifactPath, text);

    const changed = await accept(workspace, ownerToken, {
      assignmentId: ids.get("g") ?? "",
      revision: 1,
      record: record(
        [humanAnswer()],
        [{ name: "rejected", path: artifactPath, contentIdentity: ContentIdentity.ofText("x") }],
      ),
    });
    expect(changed.json.reason).toBe("artifact_identity_changed");
    expect(await storedFiles(workspace, "planning")).toEqual([]);

    const accepted = await accept(workspace, ownerToken, {
      assignmentId: ids.get("g") ?? "",
      revision: 1,
      record: record(
        [humanAnswer()],
        [{ name: "rejected", path: artifactPath, contentIdentity: ContentIdentity.ofText(text) }],
      ),
    });
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(await storedFiles(workspace, "planning")).toEqual([ContentIdentity.ofText(text)]);
  });
});

describe("operator crew next for planning work", () => {
  test("carries the records of the direct planning dependencies in resolve_planning", async () => {
    const workspace = await fixtures.make();
    const ownerToken = await ownCrew(workspace);
    const ids = await register(workspace, ownerToken, {
      sourceKind: "wayfinder",
      items: [
        { key: "r", wayfinderType: "research" },
        { key: "g", wayfinderType: "grilling", dependsOn: ["r"] },
      ],
    });
    const decided = await accept(workspace, ownerToken, {
      assignmentId: ids.get("r") ?? "",
      revision: 1,
      record: record([operatorDecision()]),
    });
    expect(decided.json.reason).toBe("assignment_accepted");

    const next = await nextActions(workspace);
    const resolve = next.forAction("resolve_planning")[0];
    const research = ids.get("r") ?? "";

    // The Operator reads a pointer, never the words of the decision.
    expect(resolve?.assignmentId).toBe(ids.get("g") ?? "");
    expect(resolve?.planningRecords).toEqual([
      {
        assignmentId: research,
        title: "Item r",
        recordId: decided.json.data.planningRecordId,
        identity: expect.stringMatching(/^[0-9a-f]{64}$/),
        entryCount: 1,
        command: `operator work record --assignment ${research}`,
      },
    ]);
    expect(next.stdout).not.toContain("Which library parses the feed?");

    // The crew reads the full record with the command the pointer names.
    const shown = await runJson(workspace, ["work", "record", "--assignment", research]);
    expect(shown.exitCode).toBe(0);
    expect(shown.json.data.record.recordId).toBe(decided.json.data.planningRecordId);
    expect(shown.json.data.record.entries).toMatchObject([
      { question: "Which library parses the feed?", authority: "operator-decision" },
    ]);

    const unknownRecord = await runJson(workspace, [
      "work",
      "record",
      "--assignment",
      research,
      "--record",
      "no-such-record",
    ]);
    expect(unknownRecord.json.reason).toBe("planning_record_missing");
    expect(unknownRecord.json.blockers[0]).toMatchObject({
      assignmentId: research,
      recordId: "no-such-record",
    });
    const unknownAssignment = await runJson(workspace, [
      "work",
      "record",
      "--assignment",
      "no-such-assignment",
    ]);
    expect(unknownAssignment.json.reason).toBe("unknown_assignment");
  });
});

describe("operator tracker record of a planning resolution", () => {
  async function acceptedPlanning(artifacts: Array<{ name: string; text: string }> = []) {
    const workspace = await makeTrackerWorkspace(fixtures, { wayfinderType: "grilling" });
    // A source in a personal folder is named on the tracker by its file name only.
    await Bun.write(`${workspace.root}/home/OPINIONS.md`, "Two update paths drift.\n");
    const files = [];
    for (const [index, artifact] of artifacts.entries()) {
      const path = `${workspace.root}/artifact-${index}.md`;
      await Bun.write(path, artifact.text);
      files.push({
        name: artifact.name,
        path,
        contentIdentity: ContentIdentity.ofText(artifact.text),
      });
    }
    const accepted = await accept(workspace, workspace.ownerToken, {
      assignmentId: workspace.assignmentId,
      revision: 1,
      record: record(
        [
          humanAnswer(),
          {
            question: "Is the old path kept?",
            escalationTriggers: ["scope"],
            authority: "requirement",
            exactText: "Build the tracker completion path.",
            source: { kind: "approved-scope", assignmentId: workspace.assignmentId },
            interpretation: {
              summary: "Only the completion path is built.",
              directives: ["Remove the old path.", "Keep one update path."],
              appliesTo: ["The tracker update."],
            },
          },
          {
            question: "Why one path?",
            escalationTriggers: [],
            authority: "requirement",
            exactText: "Two update paths drift.",
            source: { kind: "copy", path: `${workspace.root}/home/OPINIONS.md` },
            interpretation: {
              summary: "One update path.",
              directives: ["Delete the old path when the new one lands."],
              appliesTo: ["The tracker update."],
            },
          },
        ],
        files,
      ),
    });
    expect(accepted.json.reason).toBe("assignment_accepted");
    return { workspace, revision: accepted.json.data.revision as number };
  }

  test("renders the resolution body from the record", async () => {
    const { workspace, revision } = await acceptedPlanning([
      { name: "rejected", text: "## Rejected options\n\nA second update path.\n" },
    ]);

    const recorded = await recordStep(workspace, { input: { step: "resolution" }, revision });

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json.data.state).toBe("verified");
    const comments = (await githubState(workspace)).comments[String(TICKET)] ?? [];
    expect(comments).toHaveLength(1);
    const [marker, blank, ...body] = (comments[0]?.body ?? "").split("\n");
    expect(marker).toBe(`<!-- operator:tracker-operation:v1 ${recorded.json.data.operationId} -->`);
    expect(blank).toBe("");
    const fixture = await Bun.file(
      new URL("./planning-resolution.fixture.md", import.meta.url).pathname,
    ).text();
    const scopeIdentity = ContentIdentity.ofText("Build the tracker completion path.");
    const rendered = body.join("\n");
    expect(rendered).toBe(
      fixture
        .replaceAll("<assignment>", workspace.assignmentId)
        .replaceAll("<scope-revision>", scopeIdentity)
        .replaceAll("<copy-revision>", ContentIdentity.ofText("Two update paths drift.\n")),
    );
    expect(rendered).not.toContain(workspace.root);
  });

  test("refuses a free body for planning work", async () => {
    const { workspace, revision } = await acceptedPlanning();

    const refused = await recordStep(workspace, {
      input: { step: "resolution", body: "## Resolution\n\nDecided." },
      revision,
    });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("planning_body_not_allowed");
    expect((await githubState(workspace)).comments[String(TICKET)] ?? []).toEqual([]);
  });

  test("refuses a production resolution with no body", async () => {
    const workspace = await makeTrackerWorkspace(fixtures);

    const refused = await recordStep(workspace, { input: { step: "resolution" } });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("resolution_body_required");
  });

  test("refuses a rendered body over the comment limit before the write", async () => {
    const { workspace, revision } = await acceptedPlanning([
      { name: "long", text: `${"a".repeat(70_000)}\n` },
    ]);
    const before = (await githubCalls(workspace)).length;

    const refused = await recordStep(workspace, { input: { step: "resolution" }, revision });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("comment_too_long");
    expect(refused.json.blockers[0].limit).toBe(65_536);
    expect(refused.json.blockers[0].size).toBeGreaterThan(70_000);
    // Nothing reached the tracker, not even the read of the account.
    expect((await githubCalls(workspace)).length).toBe(before);
  });

  test("refuses a stored artifact that changed after acceptance", async () => {
    const text = "## Rejected options\n\nA second update path.\n";
    const { workspace, revision } = await acceptedPlanning([{ name: "rejected", text }]);
    await Bun.write(
      `${workspace.repo}/.operator/local/planning/${ContentIdentity.ofText(text)}`,
      "## Rejected options\n\nSomething else.\n",
    );

    const refused = await recordStep(workspace, { input: { step: "resolution" }, revision });

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("artifact_identity_changed");
    expect((await githubState(workspace)).comments[String(TICKET)] ?? []).toEqual([]);
  });

  test("refuses the resolution of planning work that holds no record", async () => {
    const { workspace, revision } = await acceptedPlanning();
    // An earlier release accepted planning work with no record, as this state now shows.
    const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
    sqlite.exec("delete from planning_records");
    sqlite.close();

    const refused = await recordStep(workspace, { input: { step: "resolution" }, revision });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("planning_record_missing");
  });

  test("counts the comment limit in characters, not in UTF-16 units", async () => {
    // Each emoji is one character and two UTF-16 units, so this body is under the limit.
    const { workspace, revision } = await acceptedPlanning([
      { name: "wide", text: `${"\u{1F600}".repeat(40_000)}\n` },
    ]);

    const recorded = await recordStep(workspace, { input: { step: "resolution" }, revision });

    expect(recorded.json.reason).toBe("tracker.completed");
  });
});
