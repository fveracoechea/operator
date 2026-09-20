import packageJson from "../../package.json" with { type: "json" };
import { OperatorInstallation } from "../operator-installation/main.ts";
import { exitCodeByOutcome, writeJsonResult } from "./result.ts";

const OPERATOR_VERSION = packageJson.version;
const SUPPORTED_BUN_RANGE = packageJson.engines.bun;

export async function run(args: string[]): Promise<void> {
  if (!Bun.semver.satisfies(Bun.version, SUPPORTED_BUN_RANGE)) {
    if (args.includes("--json")) {
      writeJsonResult({
        outcome: "failed",
        reason: "unsupported_bun",
        blockers: [
          {
            reason: "unsupported_bun",
            required: SUPPORTED_BUN_RANGE,
            actual: Bun.version,
          },
        ],
        operation: "startup",
        data: {
          operatorVersion: OPERATOR_VERSION,
          bunVersion: Bun.version,
        },
      });
    }
    console.error(`operator: Bun ${SUPPORTED_BUN_RANGE} is required; running ${Bun.version}.`);
    process.exitCode = exitCodeByOutcome.failed;
    return;
  }

  if (args.length === 2 && args.includes("--version") && args.includes("--json")) {
    writeJsonResult({
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: {
        operatorVersion: OPERATOR_VERSION,
        bunVersion: Bun.version,
      },
    });
    process.exitCode = exitCodeByOutcome.completed;
    return;
  }

  if (args.length === 1 && args[0] === "--version") {
    console.log(`operator ${OPERATOR_VERSION}`);
    process.exitCode = exitCodeByOutcome.completed;
    return;
  }

  if (
    args[0] === "install" &&
    args.every((argument) => argument === "install" || argument === "--json")
  ) {
    if (args.includes("--json")) {
      writeJsonResult({
        outcome: "invalid",
        reason: "install_target_required",
        blockers: [],
        operation: "install",
      });
    }
    console.error("operator install: pass --opencode, --claude, or both.");
    process.exitCode = exitCodeByOutcome.invalid;
    return;
  }

  if (args[0] === "install") {
    const allowed = new Set(["install", "--claude", "--json", "--opencode"]);
    if (args.some((argument) => !allowed.has(argument))) {
      if (args.includes("--json")) {
        writeJsonResult({
          outcome: "invalid",
          reason: "invalid_arguments",
          blockers: [],
          operation: "parse_arguments",
        });
      }
      console.error("Usage: operator install (--opencode | --claude) [--json]");
      process.exitCode = exitCodeByOutcome.invalid;
      return;
    }

    const targets = [
      ...(args.includes("--opencode") ? (["opencode"] as const) : []),
      ...(args.includes("--claude") ? (["claude"] as const) : []),
    ];
    const result = await OperatorInstallation.installSkills({
      projectRoot: process.cwd(),
      targets,
    });
    if (args.includes("--json")) {
      writeJsonResult({
        outcome: result.outcome,
        reason: result.reason,
        blockers: result.blockers,
        operation: "install",
        data:
          result.outcome === "completed"
            ? {
                targets,
                changed: result.changed,
              }
            : undefined,
      });
    } else if (result.outcome === "completed") {
      console.log(
        result.changed.length === 0
          ? "Operator skills already match this release."
          : `Installed Operator skills in ${result.changed.join(", ")}.`,
      );
    } else {
      for (const blocker of result.blockers) {
        console.error(`operator install: ${blocker.path} contains a different skill copy.`);
      }
    }
    process.exitCode = exitCodeByOutcome[result.outcome];
    return;
  }

  if (args[0] === "setup") {
    const approvalIndexes = args.flatMap((argument, index) =>
      argument === "--approve" ? [index] : [],
    );
    const approvalIndex = approvalIndexes[0];
    const approvedPlanId = approvalIndex === undefined ? undefined : args[approvalIndex + 1];
    const recoveryIndexes = args.flatMap((argument, index) =>
      argument === "--recover" ? [index] : [],
    );
    const recoveryIndex = recoveryIndexes[0];
    const recoveryPlanId = recoveryIndex === undefined ? undefined : args[recoveryIndex + 1];
    const argumentIsAllowed = args.every(
      (argument, index) =>
        argument === "setup" ||
        argument === "--claude" ||
        argument === "--json" ||
        argument === "--opencode" ||
        argument === "--approve" ||
        argument === "--recover" ||
        index === (approvalIndex ?? -2) + 1 ||
        index === (recoveryIndex ?? -2) + 1,
    );
    if (
      !argumentIsAllowed ||
      approvalIndexes.length > 1 ||
      recoveryIndexes.length > 1 ||
      (approvalIndex !== undefined && (!approvedPlanId || approvedPlanId.startsWith("--"))) ||
      (recoveryIndex !== undefined && (!recoveryPlanId || recoveryPlanId.startsWith("--")))
    ) {
      if (args.includes("--json")) {
        writeJsonResult({
          outcome: "invalid",
          reason: "invalid_arguments",
          blockers: [],
          operation: "parse_arguments",
        });
      }
      console.error(
        "Usage: operator setup (--opencode | --claude) [--approve <plan-id>] [--json]\n       operator setup --recover <plan-id> [--approve <recovery-id>] [--json]",
      );
      process.exitCode = exitCodeByOutcome.invalid;
      return;
    }

    const targets = [
      ...(args.includes("--opencode") ? (["opencode"] as const) : []),
      ...(args.includes("--claude") ? (["claude"] as const) : []),
    ];
    if (recoveryPlanId) {
      if (targets.length > 0) {
        if (args.includes("--json")) {
          writeJsonResult({
            outcome: "invalid",
            reason: "invalid_arguments",
            blockers: [],
            operation: "parse_arguments",
          });
        }
        console.error("operator setup: recovery uses the targets recorded with the setup plan.");
        process.exitCode = exitCodeByOutcome.invalid;
        return;
      }
      const result = await OperatorInstallation.recoverSetup({
        projectRoot: process.cwd(),
        planId: recoveryPlanId,
        approvedRecoveryId: approvedPlanId,
      });
      if (args.includes("--json")) {
        writeJsonResult({
          outcome: result.outcome,
          reason: result.reason,
          blockers: result.blockers,
          operation: "setup",
          data: {
            planId: result.planId,
            restored: result.restored,
            recoveryPath: result.recoveryPath,
            recoveryPlan: result.recoveryPlan,
          },
        });
      } else if (result.outcome === "completed") {
        console.log(`Recovered interrupted setup plan ${result.planId}.`);
      } else if (result.reason === "setup_recovery_approval_required") {
        console.log(JSON.stringify(result.recoveryPlan, null, 2));
        console.log(
          `Approve this unchanged recovery plan with --recover ${result.planId} --approve ${result.recoveryPlan.id}.`,
        );
      } else if (result.reason === "setup_recovery_not_found") {
        console.error(`operator setup: no recovery record exists for plan ${result.planId}.`);
      } else {
        console.error(
          `operator setup: recovery stopped; inspect ${result.recoveryPath} and the reported blockers.`,
        );
      }
      process.exitCode = exitCodeByOutcome[result.outcome];
      return;
    }
    if (targets.length === 0) {
      if (args.includes("--json")) {
        writeJsonResult({
          outcome: "invalid",
          reason: "setup_target_required",
          blockers: [],
          operation: "setup",
        });
      }
      console.error("operator setup: pass --opencode, --claude, or both.");
      process.exitCode = exitCodeByOutcome.invalid;
      return;
    }

    if (approvedPlanId) {
      const result = await OperatorInstallation.applySetup({
        projectRoot: process.cwd(),
        targets,
        approvedPlanId,
      });
      if (args.includes("--json")) {
        writeJsonResult({
          outcome: result.outcome,
          reason: result.reason,
          blockers: result.blockers,
          operation: "setup",
          data: {
            targets,
            planId: result.plan.id,
            changed: result.changed,
            ...("recoveryPath" in result ? { recoveryPath: result.recoveryPath } : {}),
            ...(result.outcome === "conflict" ? { plan: result.plan } : {}),
          },
        });
      } else if (result.outcome === "completed") {
        console.log(`Applied setup plan ${result.plan.id}.`);
      } else if (result.reason === "setup_interrupted") {
        console.error(
          `operator setup: setup stopped after a write; recover plan ${result.plan.id} before retrying.`,
        );
      } else if ("recoveryPath" in result) {
        console.error(
          `operator setup: setup stopped after a write; recover plan ${result.plan.id} before inspecting a new plan.`,
        );
      } else if (result.reason === "setup_plan_changed") {
        console.error("operator setup: the approved plan no longer matches the project.");
      } else {
        console.error(`operator setup: ${result.reason}.`);
      }
      process.exitCode = exitCodeByOutcome[result.outcome];
      return;
    }

    const result = await OperatorInstallation.inspectSetup({ projectRoot: process.cwd(), targets });
    const { blockers, outcome, plan, reason } = result;
    if (args.includes("--json")) {
      writeJsonResult({
        outcome,
        reason,
        blockers,
        operation: "setup",
        data: { targets, plan },
      });
    } else if (outcome === "completed") {
      console.log("Operator setup already matches this release.");
    } else if (outcome === "missing-condition") {
      console.log(`Setup plan ${plan.id}:`);
      for (const change of plan.changes) {
        console.log(`${change.action} ${change.path}`);
        process.stdout.write(change.content);
      }
      console.log(`Approve this unchanged plan with --approve ${plan.id}.`);
    } else {
      for (const blocker of blockers) {
        console.error(`operator setup: ${"path" in blocker ? blocker.path : blocker.reason}`);
      }
    }
    process.exitCode = exitCodeByOutcome[outcome];
    return;
  }

  if (args.includes("--json")) {
    writeJsonResult({
      outcome: "invalid",
      reason: "invalid_arguments",
      blockers: [],
      operation: "parse_arguments",
    });
  }
  console.error("Usage: operator --version [--json]");
  process.exitCode = exitCodeByOutcome.invalid;
}
