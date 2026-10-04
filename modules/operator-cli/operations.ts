import {
  type CrewFlag,
  type FlagName,
  flagPlaceholder,
  hasFlags,
  type ParsedArguments,
  splitRequest,
} from "./arguments.ts";
import * as approval from "./approval-command.ts";
import * as attempt from "./attempt-command.ts";
import * as cleanup from "./cleanup-command.ts";
import * as config from "./config-command.ts";
import { runCrewOwn } from "./crew-command.ts";
import * as gate from "./gate-command.ts";
import { runHealthcheck } from "./healthcheck-command.ts";
import * as install from "./install-command.ts";
import { runInvalidate } from "./invalidate-command.ts";
import { runCrewNext } from "./next-command.ts";
import { runDispose as runOutsideDispose } from "./outside-command.ts";
import { runProbeApply, runProbeCleanup, runProbePlan } from "./probe-command.ts";
import * as publish from "./publish-command.ts";
import * as question from "./question-command.ts";
import { runReadiness } from "./readiness-command.ts";
import { runRebase } from "./rebase-command.ts";
import { exitCodeByOutcome, type Handled, report, writeJsonResult } from "./result.ts";
import * as review from "./review-command.ts";
import { runRework } from "./rework-command.ts";
import * as setup from "./setup-command.ts";
import { runTakeOut } from "./take-out-command.ts";
import * as tracker from "./tracker-command.ts";
import * as update from "./update-command.ts";
import * as wake from "./wake-command.ts";
import * as work from "./work-command.ts";

/**
 * One word of a usage line: a flag the line shows as required, an optional flag in brackets,
 * the choice of targets, or the config changes.
 */
type Token = FlagName | `[${FlagName}]` | "targets" | "changes";

/** The operations that report a missing target. Operator never infers one from the agents it finds. */
type TargetOperation =
  | "install"
  | "install_matt_plan"
  | "install_matt_apply"
  | "update_plan"
  | "update_apply"
  | "setup_plan"
  | "setup_apply"
  | "setup_readiness"
  | "healthcheck"
  | "setup_probe_plan"
  | "setup_probe_apply"
  | "crew_next";

type Run<R extends CrewFlag> = (parsed: ParsedArguments<R>) => Promise<Handled | void>;

type Spec<R extends CrewFlag> = {
  /** The lines of the usage text. Together with `unlisted`, they name every flag it accepts. */
  usage: Token[][];
  /** Forms the usage text leaves out. */
  unlisted?: Token[][];
  /** The crew flags without which the request is invalid. */
  required?: readonly R[];
  /** A further rule on the flag values, checked before the target. */
  refuses?: (parsed: ParsedArguments<NoInfer<R>>) => boolean;
  needsTarget?: TargetOperation;
  run: Run<NoInfer<R>>;
};

type Entry = {
  usage: Token[][];
  accepts: ReadonlySet<string>;
  needsTarget: TargetOperation | undefined;
  /** The handler bound to the request, or null when a required flag or a rule refuses it. */
  admit: (parsed: ParsedArguments) => (() => Promise<Handled | void>) | null;
};

const flagsOfToken: Record<"targets" | "changes", string[]> = {
  targets: ["--opencode", "--claude"],
  changes: ["--set", "--unset"],
};

function operation<const R extends CrewFlag = never>(spec: Spec<R>): Entry {
  const tokens = [...spec.usage, ...(spec.unlisted ?? [])].flat();
  return {
    usage: spec.usage,
    accepts: new Set([
      "--json",
      ...tokens.flatMap((token) =>
        token === "targets" || token === "changes"
          ? flagsOfToken[token]
          : [token.replace(/^\[(.*)\]$/, "$1")],
      ),
    ]),
    needsTarget: spec.needsTarget,
    admit: (parsed) =>
      hasFlags(parsed, spec.required ?? []) && !(spec.refuses?.(parsed) ?? false)
        ? () => spec.run(parsed)
        : null,
  };
}

function givesEmptyValue(parsed: ParsedArguments): boolean {
  return parsed.given.some(({ value }) => value === "");
}

const selection: Token[] = ["[--operator-host]", "[--operator-model]"];
const crewSelection: Token[] = ["[--crew-host]", "[--crew-model]"];
const mutation = ["--request", "--owner-token"] as const;

/**
 * Every operation, keyed by its words, in the order of the usage text. A request that gives a
 * flag its entry does not name, or misses a required flag or target, is refused before the
 * handler runs.
 */
const operations: Record<string, Entry> = {
  healthcheck: operation({
    usage: [["targets", ...selection, ...crewSelection]],
    needsTarget: "healthcheck",
    run: runHealthcheck,
  }),
  install: operation({ usage: [["targets"]], needsTarget: "install", run: install.runInstall }),
  "install matt plan": operation({
    usage: [["targets"]],
    needsTarget: "install_matt_plan",
    run: install.runMattPlan,
  }),
  "install matt apply": operation({
    usage: [["targets", "--commit", "--approved-plan"]],
    required: ["--commit"],
    refuses: (parsed) => !/^[a-f0-9]{40}$/.test(parsed.crew.baseCommit),
    needsTarget: "install_matt_apply",
    run: install.runMattApply,
  }),
  "update plan": operation({
    usage: [["targets", "--commit", "[--delivery]", "[--package-version]"]],
    needsTarget: "update_plan",
    run: update.runPlan,
  }),
  "update apply": operation({
    usage: [["targets", "--commit", "[--delivery]", "[--package-version]", "--approved-update"]],
    needsTarget: "update_apply",
    run: update.runApply,
  }),
  "setup plan": operation({ usage: [["targets"]], needsTarget: "setup_plan", run: setup.runPlan }),
  "setup apply": operation({
    usage: [["targets", "--approved-plan"]],
    needsTarget: "setup_apply",
    run: setup.runApply,
  }),
  "setup rollback": operation({ usage: [[]], run: setup.runRollback }),
  "setup readiness": operation({
    usage: [["targets", ...selection, ...crewSelection]],
    needsTarget: "setup_readiness",
    run: runReadiness,
  }),
  "setup probe plan": operation({
    usage: [["targets", ...selection, ...crewSelection, "[--stale-only]"]],
    needsTarget: "setup_probe_plan",
    run: runProbePlan,
  }),
  "setup probe apply": operation({
    usage: [["targets", ...selection, ...crewSelection, "[--stale-only]", "--approved-probe"]],
    needsTarget: "setup_probe_apply",
    run: runProbeApply,
  }),
  "setup probe cleanup": operation({ usage: [["[--approved-cleanup]"]], run: runProbeCleanup }),
  "config show": operation({ usage: [[]], run: config.runShow }),
  "config plan": operation({ usage: [["changes"]], run: config.runPlan }),
  "config apply": operation({ usage: [["changes", "--approved-plan"]], run: config.runApply }),
  "config recover": operation({ usage: [[]], run: config.runRecover }),
  "crew own": operation({
    usage: [
      ["--request", "--owner-label"],
      ["--request", "--owner-label", "--takeover", "--ownership-revision"],
    ],
    required: ["--request", "--owner-label"],
    run: runCrewOwn,
  }),
  "crew next": operation({
    usage: [["targets", ...selection, ...crewSelection]],
    needsTarget: "crew_next",
    run: runCrewNext,
  }),
  "work register": operation({
    usage: [
      ["--plan", "--input"],
      [...mutation, "--input", "--plan-revision"],
    ],
    required: ["--input"],
    run: work.runRegister,
  }),
  "work claim": operation({
    usage: [[...mutation, "--assignment", "--revision"]],
    required: [...mutation, "--assignment", "--revision"],
    run: work.runClaim,
  }),
  "work accept": operation({
    usage: [
      [...mutation, "--assignment", "--revision", "[--attempt]", "[--submission]", "[--input]"],
    ],
    required: [...mutation, "--assignment", "--revision"],
    run: work.runAccept,
  }),
  "work rework": operation({
    usage: [[...mutation, "--assignment", "--revision", "--input"]],
    required: [...mutation, "--assignment", "--revision", "--input"],
    run: runRework,
  }),
  "work dispose": operation({
    usage: [[...mutation, "--submission", "--input"]],
    required: [...mutation, "--submission", "--input"],
    run: runOutsideDispose,
  }),
  "work invalidate": operation({
    usage: [[...mutation, "--assignment", "--revision", "--input"]],
    required: [...mutation, "--assignment", "--revision", "--input"],
    run: runInvalidate,
  }),
  "work rebase": operation({
    usage: [
      ["--source", "--base"],
      [...mutation, "--source", "--base", "--plan-revision"],
    ],
    required: ["--source", "--base"],
    run: runRebase,
  }),
  "work frontier": operation({ usage: [[]], run: work.runFrontier }),
  "work overlaps": operation({
    usage: [["--source"]],
    required: ["--source"],
    run: work.runOverlaps,
  }),
  "work write-paths": operation({
    usage: [["--assignment", "[--input]"]],
    required: ["--assignment"],
    run: work.runWritePaths,
  }),
  "work record": operation({
    usage: [["--assignment", "[--record]"]],
    required: ["--assignment"],
    run: work.runRecord,
  }),
  "work take-out": operation({
    usage: [],
    unlisted: [[...mutation, "--source", "--plan-revision"]],
    required: [...mutation, "--source", "--plan-revision"],
    run: runTakeOut,
  }),
  "attempt dispatch": operation({
    usage: [[...mutation, "--attempt", "--commit", "[--branch]", "[--worktree]", ...crewSelection]],
    required: [...mutation, "--attempt"],
    run: attempt.runDispatch,
  }),
  "attempt acknowledge": operation({
    usage: [["--request", "--attempt"]],
    required: ["--request", "--attempt"],
    run: attempt.runAcknowledge,
  }),
  "attempt reconcile": operation({
    usage: [[...mutation, "--attempt"]],
    required: [...mutation, "--attempt"],
    run: attempt.runReconcile,
  }),
  "attempt adopt": operation({
    usage: [[...mutation, "--attempt"]],
    required: [...mutation, "--attempt"],
    run: attempt.runAdopt,
  }),
  "attempt replace": operation({
    usage: [[...mutation, "--attempt", "[--inspection]"]],
    required: [...mutation, "--attempt"],
    run: attempt.runReplace,
  }),
  "attempt show": operation({
    usage: [["--attempt"]],
    required: ["--attempt"],
    run: attempt.runShow,
  }),
  "attempt submit": operation({
    usage: [["--request", "--attempt", "--input"]],
    required: ["--request", "--attempt", "--input"],
    run: attempt.runSubmit,
  }),
  "question raise": operation({
    usage: [["--request", "--attempt", "--input"]],
    required: ["--request", "--attempt", "--input"],
    run: question.runRaise,
  }),
  "question revise": operation({
    usage: [["--request", "--attempt", "--question", "--revision", "--input"]],
    required: ["--request", "--attempt", "--question", "--revision", "--input"],
    run: question.runRevise,
  }),
  "question escalate": operation({
    usage: [[...mutation, "--question", "--revision", "--input"]],
    required: [...mutation, "--question", "--revision", "--input"],
    run: question.runEscalate,
  }),
  "question answer": operation({
    usage: [[...mutation, "--question", "--revision", "--input"]],
    required: [...mutation, "--question", "--revision", "--input"],
    run: question.runAnswer,
  }),
  "question reapply": operation({
    usage: [[...mutation, "--question", "--revision", "--answer", "--approval"]],
    required: [...mutation, "--question", "--revision", "--answer", "--approval"],
    run: question.runReapply,
  }),
  "question deliver": operation({
    usage: [[...mutation, "--question"]],
    required: [...mutation, "--question"],
    run: question.runDeliver,
  }),
  "question acknowledge": operation({
    usage: [["--request", "--question"]],
    required: ["--request", "--question"],
    run: question.runAcknowledge,
  }),
  "question show": operation({
    usage: [["--question"]],
    required: ["--question"],
    run: question.runShow,
  }),
  "approval grant": operation({
    usage: [[...mutation, "--input"]],
    required: [...mutation, "--input"],
    run: approval.runGrant,
  }),
  "approval revoke": operation({
    usage: [[...mutation, "--approval", "--revision"]],
    required: [...mutation, "--approval", "--revision"],
    run: approval.runRevoke,
  }),
  "approval check": operation({
    usage: [["--input"]],
    required: ["--input"],
    run: approval.runCheck,
  }),
  "review report": operation({
    usage: [["--request", "--review", "--input"]],
    unlisted: [["--request", "--review", "--input", "[--attempt]"]],
    required: ["--request", "--review", "--input"],
    run: review.runReport,
  }),
  "review dispose": operation({
    usage: [[...mutation, "--review", "--input"]],
    required: [...mutation, "--review", "--input"],
    run: review.runDispose,
  }),
  "review show": operation({
    usage: [["--review"]],
    required: ["--review"],
    run: review.runShow,
  }),
  "tracker record": operation({
    usage: [[...mutation, "--assignment", "--revision", "--input", "[--approval]"]],
    required: [...mutation, "--assignment", "--revision", "--input"],
    run: tracker.runRecord,
  }),
  "tracker recover": operation({
    usage: [[...mutation, "--operation"]],
    required: [...mutation, "--operation"],
    run: tracker.runRecover,
  }),
  "tracker show": operation({
    usage: [["--assignment"]],
    required: ["--assignment"],
    run: tracker.runShow,
  }),
  "tracker map": operation({
    usage: [["--assignment"]],
    required: ["--assignment"],
    run: tracker.runMap,
  }),
  "gate run": operation({
    usage: [
      [...mutation, "--source", "--commit", "[--approval]"],
      [...mutation, "--assignment", "[--approval]"],
      [...mutation, "--source", "--base", "[--approval]"],
    ],
    // The take-out subject names only the source.
    unlisted: [[...mutation, "--source", "[--approval]"]],
    required: [...mutation],
    run: gate.runStart,
  }),
  "gate show": operation({ usage: [["--run"]], required: ["--run"], run: gate.runShow }),
  "gate runner": operation({
    usage: [["--run", "--root"]],
    required: ["--run", "--root"],
    run: gate.runRunner,
  }),
  "publish plan": operation({
    usage: [["--source"]],
    required: ["--source"],
    run: publish.runPlan,
  }),
  "publish apply": operation({
    usage: [[...mutation, "--source", "--plan-revision"]],
    required: [...mutation, "--source", "--plan-revision"],
    run: publish.runApply,
  }),
  "publish status": operation({
    usage: [[...mutation, "--source"]],
    required: [...mutation, "--source"],
    run: publish.runStatus,
  }),
  "publish retarget": operation({
    usage: [[...mutation, "--source", "--part"]],
    required: [...mutation, "--source", "--part"],
    run: publish.runRetarget,
  }),
  "publish recall": operation({
    usage: [["--source"], [...mutation, "--source", "--plan-revision"]],
    required: ["--source"],
    run: publish.runRecall,
  }),
  "cleanup close": operation({
    usage: [[...mutation, "--attempt"]],
    required: [...mutation, "--attempt"],
    run: cleanup.runClose,
  }),
  "cleanup remove": operation({
    usage: [[...mutation, "--attempt"]],
    required: [...mutation, "--attempt"],
    run: cleanup.runRemove,
  }),
  "cleanup hold": operation({
    usage: [[...mutation, "--attempt", "--input"]],
    required: [...mutation, "--attempt", "--input"],
    run: cleanup.runHold,
  }),
  "cleanup release": operation({
    usage: [[...mutation, "--attempt", "--revision"]],
    required: [...mutation, "--attempt", "--revision"],
    run: cleanup.runRelease,
  }),
  "cleanup show": operation({ usage: [["[--attempt]"]], run: cleanup.runShow }),
  // The Operator and the Herdr plugin launcher call wake, so the usage text leaves it out.
  // Wake reads no empty value, and its armed `crew next` needs a target of its own.
  "wake plugin-path": operation({ usage: [], unlisted: [[]], run: wake.runPluginPath }),
  "wake arm": operation({
    usage: [],
    unlisted: [["--owner-label", "targets", ...selection, ...crewSelection, "[--operator-bin]"]],
    required: ["--owner-label"],
    refuses: (parsed) => parsed.targets.length === 0 || givesEmptyValue(parsed),
    run: wake.runArm,
  }),
  "wake check": operation({
    usage: [],
    unlisted: [["--root", "[--event]"]],
    required: ["--root"],
    refuses: givesEmptyValue,
    run: wake.runCheck,
  }),
};

const choices: Record<"targets" | "changes", string> = {
  targets: "(--opencode | --claude | --opencode --claude)",
  changes: "(--set <path=value> | --unset <path>)...",
};

function usageToken(token: Token): string {
  if (token === "targets" || token === "changes") return choices[token];
  const optional = token.startsWith("[");
  const flag = optional ? token.slice(1, -1) : token;
  const placeholder = flagPlaceholder(flag);
  const shown = placeholder === null ? flag : `${flag} ${placeholder}`;
  return optional ? `[${shown}]` : shown;
}

export const usage = [
  "Usage:",
  "  operator --version [--json]",
  ...Object.entries(operations).flatMap(([words, entry]) =>
    entry.usage.map((tokens) =>
      ["  operator", words, ...tokens.map(usageToken), "[--json]"].join(" "),
    ),
  ),
  "",
  "A host is `opencode` or `claude-code`.",
  "A delivery path is `github-source` or `jsr`; `jsr` also needs an exact package version.",
  "Config fields: operator.host/model, crew.host/model/reasoningEffort/maxActiveAgents, probe.githubFixture.repository/issue/mapIssue.",
  "Unset probe.githubFixture to remove the fixture.",
].join("\n");

/** The first word of every operation, which a project invocation rewrites in a printed command. */
export const commandWords = [
  ...new Set(Object.keys(operations).map((key) => key.replace(/ .*/, ""))),
];

export function rejectArguments(json: boolean): void {
  if (json) {
    writeJsonResult({
      outcome: "invalid",
      reason: "invalid_arguments",
      blockers: [],
      operation: "parse_arguments",
    });
  }
  console.error(usage);
  process.exitCode = exitCodeByOutcome.invalid;
}

function reportMissingTarget(parsed: ParsedArguments, operation: TargetOperation): void {
  console.error(usage);
  report({
    json: parsed.json,
    result: {
      outcome: "invalid",
      reason: "missing_target",
      blockers: [{ reason: "missing_target", required: ["--opencode", "--claude"] }],
      operation,
    },
    lines: [],
  });
}

/**
 * Runs the operation that the words name, or returns false when no operation has these words.
 * Every refused request ends with the usage text and the `invalid_arguments` result.
 */
export async function runOperation(command: string, rest: string[]): Promise<boolean> {
  const { words, parsed } = splitRequest(rest);
  const all = [command, ...words];
  const key = all.join(" ");
  const entry =
    all.every((word) => !/\s/.test(word)) && Object.hasOwn(operations, key)
      ? operations[key]
      : undefined;
  if (entry === undefined) return false;

  const admitted =
    parsed.unsupported.length === 0 && parsed.given.every(({ flag }) => entry.accepts.has(flag))
      ? entry.admit(parsed)
      : null;
  if (admitted === null) {
    rejectArguments(parsed.json);
  } else if (entry.needsTarget !== undefined && parsed.targets.length === 0) {
    reportMissingTarget(parsed, entry.needsTarget);
  } else if ((await admitted()) === "invalid-arguments") {
    rejectArguments(parsed.json);
  }
  return true;
}
