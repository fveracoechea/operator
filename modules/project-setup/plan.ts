import { ContentIdentity } from "../content-identity/main.ts";
import { OperatorConfig } from "../operator-config/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";

export type SetupTarget = "opencode" | "claude-code";

export type SetupChange = {
  path: string;
  kind: "create" | "append" | "replace";
  reason: string;
  addedText: string;
  nextText: string;
  previousText: string | null;
};

export type SetupConflict = {
  reason:
    | "operator_directory_tracked"
    | "invalid_configuration"
    | "instructions_modified"
    | "skill_copy_modified"
    | "git_unavailable";
  path?: string;
  paths?: string[];
  detail: string;
};

export type SetupPlan = {
  planId: string;
  targets: SetupTarget[];
  changes: SetupChange[];
  conflicts: SetupConflict[];
};

export const CONFIG_PATH = OperatorConfig.configPath();
export const SCHEMA_PATH = OperatorConfig.schemaPath();
export const IGNORE_PATH = ".gitignore";
export const INSTRUCTIONS_PATH = "AGENTS.md";
export const CLAUDE_IMPORT_PATH = "CLAUDE.md";

const IGNORE_BLOCK = ["# Operator local files, written by `operator setup`.", "/.operator/"].join(
  "\n",
);
const CLAUDE_IMPORT = "@AGENTS.md";

const INSTRUCTIONS_BEGIN = "<!-- operator:instructions -->";
const INSTRUCTIONS_END = "<!-- /operator:instructions -->";
const instructionsSection = [
  INSTRUCTIONS_BEGIN,
  "## Operator",
  "",
  "This project is coordinated with Operator.",
  "Load the `operator` skill before you delegate work, change the crew configuration, or run a setup operation.",
  "Read only these Operator files directly: your dispatch brief, its fixed artifacts, and each file a CLI result names.",
  "Read and change all other Operator configuration and state through Operator CLI commands, such as `config show` and `config plan`.",
  "You may write JSON requests for the `--input` of a command.",
  "Operator configuration is local to this checkout and is not committed.",
  INSTRUCTIONS_END,
].join("\n");

// The sections earlier releases wrote. Setup proposes this release's section in place of one of
// them under the usual plan approval; any other text in the markers is a person's edit.
const earlierSections = [
  [
    INSTRUCTIONS_BEGIN,
    "## Operator",
    "",
    "This project is coordinated with Operator.",
    "Load the `operator` skill before you delegate work, change the crew configuration, or run a setup operation.",
    "Operator configuration lives in `.operator/config.json`, which is local to this checkout and is not committed.",
    INSTRUCTIONS_END,
  ].join("\n"),
];

const GIT_TIMEOUT_MS = 30_000;

export async function readTextOrNull(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

function createChange(path: string, reason: string, text: string): SetupChange {
  return { path, kind: "create", reason, addedText: text, nextText: text, previousText: null };
}

function appendChange(
  path: string,
  reason: string,
  previousText: string,
  block: string,
): SetupChange {
  const separator = previousText.length === 0 || previousText.endsWith("\n") ? "" : "\n";
  const addedText = `${separator}${previousText.length === 0 ? "" : "\n"}${block}\n`;
  return {
    path,
    kind: "append",
    reason,
    addedText,
    nextText: previousText + addedText,
    previousText,
  };
}

function ignoresOperatorDirectory(text: string): boolean {
  return text
    .split("\n")
    .some((line) => ["/.operator/", "/.operator", ".operator/", ".operator"].includes(line.trim()));
}

function importsAgentsFile(text: string): boolean {
  return text.split("\n").some((line) => line.trim() === CLAUDE_IMPORT);
}

type PlanStep = { change?: SetupChange; conflict?: SetupConflict };

async function planGeneratedFile(
  projectRoot: string,
  path: string,
  reason: string,
  text: string,
): Promise<PlanStep> {
  const previousText = await readTextOrNull(`${projectRoot}/${path}`);
  if (previousText === null) {
    return { change: createChange(path, reason, text) };
  }
  if (previousText === text) {
    return {};
  }

  return {
    change: { path, kind: "replace", reason, addedText: text, nextText: text, previousText },
  };
}

async function planConfiguration(projectRoot: string): Promise<PlanStep> {
  const previousText = await readTextOrNull(`${projectRoot}/${CONFIG_PATH}`);
  if (previousText === null) {
    return {
      change: createChange(
        CONFIG_PATH,
        "Create the default Operator configuration.",
        OperatorConfig.defaultFileText(),
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(previousText);
  } catch (error) {
    return {
      conflict: {
        reason: "invalid_configuration",
        path: CONFIG_PATH,
        detail: `The existing configuration is not valid JSON: ${String(error)}`,
      },
    };
  }

  const result = OperatorConfig.parse(parsed);
  if (!result.ok) {
    return {
      conflict: {
        reason: "invalid_configuration",
        path: CONFIG_PATH,
        detail: `The existing configuration is invalid: ${result.issues.join("; ")}`,
      },
    };
  }

  return {};
}

async function planIgnoreRules(projectRoot: string): Promise<PlanStep> {
  const previousText = await readTextOrNull(`${projectRoot}/${IGNORE_PATH}`);
  if (previousText === null) {
    return {
      change: createChange(
        IGNORE_PATH,
        "Ignore the local Operator directory.",
        `${IGNORE_BLOCK}\n`,
      ),
    };
  }
  if (ignoresOperatorDirectory(previousText)) {
    return {};
  }

  return {
    change: appendChange(
      IGNORE_PATH,
      "Ignore the local Operator directory without changing the existing rules.",
      previousText,
      IGNORE_BLOCK,
    ),
  };
}

async function planInstructions(projectRoot: string): Promise<PlanStep> {
  const previousText = await readTextOrNull(`${projectRoot}/${INSTRUCTIONS_PATH}`);
  if (previousText === null) {
    return {
      change: createChange(
        INSTRUCTIONS_PATH,
        "Add the Operator instruction section.",
        `${instructionsSection}\n`,
      ),
    };
  }

  const begin = previousText.indexOf(INSTRUCTIONS_BEGIN);
  const end = previousText.indexOf(INSTRUCTIONS_END);
  if (begin === -1 || end === -1 || end < begin) {
    return {
      change: appendChange(
        INSTRUCTIONS_PATH,
        "Add the Operator instruction section without changing the existing instructions.",
        previousText,
        instructionsSection,
      ),
    };
  }

  // The marked section, markers included, must be exactly the one this release writes.
  const section = previousText.slice(begin, end + INSTRUCTIONS_END.length);
  if (earlierSections.includes(section)) {
    const nextText =
      previousText.slice(0, begin) +
      instructionsSection +
      previousText.slice(end + INSTRUCTIONS_END.length);
    return {
      change: {
        path: INSTRUCTIONS_PATH,
        kind: "replace",
        reason: "Replace the Operator instruction section of an earlier release.",
        addedText: instructionsSection,
        nextText,
        previousText,
      },
    };
  }
  if (section !== instructionsSection) {
    return {
      conflict: {
        reason: "instructions_modified",
        path: INSTRUCTIONS_PATH,
        detail:
          "The marked Operator section differs from this release. Decide what it should say before setup writes it.",
      },
    };
  }

  return {};
}

async function planClaudeImport(projectRoot: string): Promise<PlanStep> {
  const reason = "Import AGENTS.md so Claude Code loads the Operator instructions.";
  const previousText = await readTextOrNull(`${projectRoot}/${CLAUDE_IMPORT_PATH}`);
  if (previousText === null) {
    return { change: createChange(CLAUDE_IMPORT_PATH, reason, `${CLAUDE_IMPORT}\n`) };
  }
  if (importsAgentsFile(previousText)) {
    return {};
  }

  return { change: appendChange(CLAUDE_IMPORT_PATH, reason, previousText, CLAUDE_IMPORT) };
}

/** Reads which .operator paths Git already tracks. Setup never writes to the Git index. */
async function inspectGitIndex(projectRoot: string): Promise<SetupConflict | undefined> {
  const listed = await ToolInvocation.git({
    repoRoot: projectRoot,
    args: ["ls-files", "-z", "--", ".operator"],
    raw: true,
    timeoutMs: GIT_TIMEOUT_MS,
    answers: "any",
    // This call once ran in the project folder with no `-C`, so its detail names `ls-files`.
    failed: (failure) =>
      failure.kind === "no-answer"
        ? `git ls-files ended on ${failure.signal} with no answer.`
        : ToolInvocation.gitFailure(failure),
  });
  if (listed.status !== "read") {
    return {
      reason: "git_unavailable",
      detail: `Setup cannot read the Git index, so it cannot check for tracked Operator files: ${listed.detail.replace(/\.$/, "")}. Install Git yourself, then plan again.`,
    };
  }
  // A failed listing means the project is not a Git repository, so it has no index and tracks nothing.
  const paths = listed.exitCode === 0 ? listed.value.split("\0").filter(Boolean).toSorted() : [];
  if (paths.length === 0) {
    return undefined;
  }

  return {
    reason: "operator_directory_tracked",
    paths,
    detail:
      "An ignore rule does not untrack a file. Remove these paths from the Git index yourself, then plan again.",
  };
}

async function inspectSkillCopies(
  projectRoot: string,
  targets: SetupTarget[],
): Promise<SetupConflict[]> {
  const inspection = await SkillInstall.inspect({ projectRoot, targets });
  return inspection.conflicts.map((conflict) => ({
    reason: "skill_copy_modified" as const,
    paths: conflict.paths,
    detail: `The ${conflict.target} copy of the ${conflict.skill} skill differs from this Operator release. Restore or remove it, then plan again.`,
  }));
}

export async function computePlan(projectRoot: string, targets: SetupTarget[]): Promise<SetupPlan> {
  const steps: PlanStep[] = [];
  const conflicts: SetupConflict[] = [];

  const gitConflict = await inspectGitIndex(projectRoot);
  if (gitConflict) {
    conflicts.push(gitConflict);
  }
  conflicts.push(...(await inspectSkillCopies(projectRoot, targets)));

  steps.push(
    await planGeneratedFile(
      projectRoot,
      SCHEMA_PATH,
      "Copy the editor schema that matches this Operator release.",
      OperatorConfig.jsonSchemaText(),
    ),
  );
  steps.push(await planConfiguration(projectRoot));
  steps.push(await planIgnoreRules(projectRoot));
  steps.push(await planInstructions(projectRoot));
  if (targets.includes("claude-code")) {
    steps.push(await planClaudeImport(projectRoot));
  }

  const changes = steps.flatMap((step) => (step.change ? [step.change] : []));
  conflicts.push(...steps.flatMap((step) => (step.conflict ? [step.conflict] : [])));

  return { planId: planIdentity(targets, changes), targets, changes, conflicts };
}

/** The identity covers the targets, the observed file, and the exact content of every change. */
function planIdentity(targets: SetupTarget[], changes: SetupChange[]): string {
  return ContentIdentity.ofText(
    JSON.stringify({
      targets: targets.toSorted(),
      changes: changes.map((change) => [
        change.path,
        change.kind,
        change.previousText === null ? null : ContentIdentity.ofText(change.previousText),
        ContentIdentity.ofText(change.nextText),
      ]),
    }),
  );
}
