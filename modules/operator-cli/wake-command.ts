import { CrewWake } from "../crew-wake/main.ts";
// Bun has no path manipulation API.
import { resolve } from "node:path";
import type { ParsedArguments } from "./arguments.ts";
import { type Handled, refuse, report } from "./result.ts";

// The wake command is called by the Operator and the Herdr plugin launcher.

export async function runPluginPath(parsed: ParsedArguments): Promise<Handled> {
  const path = resolve(import.meta.dir, "../../herdr");
  report({
    json: parsed.json,
    result: {
      outcome: "completed",
      reason: "wake_plugin_path",
      blockers: [],
      operation: "wake_plugin_path",
      data: { path },
    },
    lines: [path],
  });
  return "reported";
}

/** Arms the wake. The recorded `crew next` repeats the target and selection flags as given. */
export async function runArm(parsed: ParsedArguments<"--owner-label">): Promise<Handled> {
  const targets = parsed.given.filter(({ flag }) => flag === "--opencode" || flag === "--claude");
  const selection = parsed.given.filter(({ flag }) =>
    /^--(operator|crew)-(host|model)$/.test(flag),
  );
  const compiledCli = resolve(import.meta.dir, "../../cli.js");
  const cliBin = (await Bun.file(compiledCli).exists())
    ? compiledCli
    : resolve(import.meta.dir, "../../cli.ts");
  return reportWake(parsed, "wake_arm", () =>
    CrewWake.arm({
      root: process.cwd(),
      owner: parsed.crew.ownerLabel,
      targets: [
        ...targets.map(({ flag }) => flag),
        ...selection.flatMap(({ flag, value }) => [flag, value ?? ""]),
      ],
      operatorBin: parsed.operatorBin ?? cliBin,
      cliBin,
      pane: process.env.HERDR_PANE_ID ?? "",
    }),
  );
}

export async function runCheck(parsed: ParsedArguments<"--root">): Promise<Handled> {
  return reportWake(parsed, "wake_check", () =>
    CrewWake.check({ root: parsed.crew.projectRoot, event: parsed.event }),
  );
}

async function reportWake(
  parsed: ParsedArguments,
  operation: "wake_arm" | "wake_check",
  wake: () => Promise<string>,
): Promise<Handled> {
  try {
    const message = await wake();
    report({
      json: parsed.json,
      result: {
        outcome: "completed",
        reason: operation === "wake_arm" ? "wake_armed" : "wake_checked",
        blockers: [],
        operation,
        data: { message },
      },
      lines: [message],
    });
    return "reported";
  } catch (error) {
    return refuse({
      json: parsed.json,
      operation,
      outcome: "failed",
      reason: "wake_failed",
      detail: { message: String(error) },
      lines: [String(error)],
    });
  }
}
