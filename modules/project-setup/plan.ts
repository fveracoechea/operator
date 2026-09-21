import { OperatorConfig } from "../operator-config/main.ts";
import { SkillInstall } from "../skill-install/main.ts";
import { endsWithNewline, readTextOrNull, sha256 } from "./files.ts";
import { trackedOperatorPaths } from "./git.ts";
import { findInstructionsSection, instructionsSection } from "./instructions.ts";

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

export const CONFIG_PATH = ".operator/config.json";
export const SCHEMA_PATH = ".operator/config.schema.json";
export const IGNORE_PATH = ".gitignore";
export const INSTRUCTIONS_PATH = "AGENTS.md";
export const CLAUDE_IMPORT_PATH = "CLAUDE.md";

const IGNORE_BLOCK = ["# Operator local files, written by `operator setup`.", "/.operator/"].join(
  "\n",
);
const CLAUDE_IMPORT = "@AGENTS.md";

function createChange(path: string, reason: string, text: string): SetupChange {
  return { path, kind: "create", reason, addedText: text, nextText: text, previousText: null };
}

function appendChange(
  path: string,
  reason: string,
  previousText: string,
  block: string,
): SetupChange {
  const separator = endsWithNewline(previousText) ? "" : "\n";
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

  const existingSection = findInstructionsSection(previousText);
  if (existingSection === null) {
    return {
      change: appendChange(
        INSTRUCTIONS_PATH,
        "Add the Operator instruction section without changing the existing instructions.",
        previousText,
        instructionsSection,
      ),
    };
  }

  if (existingSection !== instructionsSection) {
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

async function inspectGitIndex(projectRoot: string): Promise<SetupConflict | undefined> {
  const tracked = await trackedOperatorPaths(projectRoot);
  if (tracked.state === "unavailable") {
    return {
      reason: "git_unavailable",
      detail: `Setup cannot read the Git index, so it cannot check for tracked Operator files: ${tracked.detail}. Install Git yourself, then plan again.`,
    };
  }
  if (tracked.paths.length === 0) {
    return undefined;
  }

  return {
    reason: "operator_directory_tracked",
    paths: tracked.paths,
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
  return sha256(
    JSON.stringify({
      targets: targets.toSorted(),
      changes: changes.map((change) => [
        change.path,
        change.kind,
        change.previousText === null ? null : sha256(change.previousText),
        sha256(change.nextText),
      ]),
    }),
  );
}
