import { CrewWake } from "../crew-wake/main.ts";
// Bun has no path manipulation API.
import { resolve } from "node:path";
import { type Handled, refuse, report } from "./result.ts";

function readWakeFlags(flags: string[]) {
  const options = new Map<string, string>();
  const targets: string[] = [];
  const selection: string[] = [];
  const selectionFlags = new Set([
    "--operator-host",
    "--operator-model",
    "--crew-host",
    "--crew-model",
  ]);
  let json = false;
  let event = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--json") json = true;
    else if (flag === "--event") event = true;
    else if (flag === "--opencode" || flag === "--claude") targets.push(flag);
    else if (
      flag !== undefined &&
      selectionFlags.has(flag) &&
      flags[index + 1] &&
      !flags[index + 1]?.startsWith("--")
    ) {
      selection.push(flag, flags[++index] ?? "");
    } else if (
      (flag === "--owner-label" || flag === "--operator-bin" || flag === "--root") &&
      flags[index + 1] &&
      !flags[index + 1]?.startsWith("--")
    ) {
      options.set(flag, flags[++index] ?? "");
    } else return null;
  }
  return { options, targets, selection, json, event };
}

/** The wake command is called by the Operator and the Herdr plugin launcher. */
export async function runWake(args: string[]): Promise<Handled> {
  const [mode, ...flags] = args;
  const parsed = readWakeFlags(flags);
  if (parsed === null) return "invalid-arguments";
  const { options, targets, selection, json, event } = parsed;
  const root = options.get("--root");
  const owner = options.get("--owner-label");
  const compiledCli = resolve(import.meta.dir, "../../cli.js");
  const cliBin = (await Bun.file(compiledCli).exists())
    ? compiledCli
    : resolve(import.meta.dir, "../../cli.ts");
  if (mode === "plugin-path") {
    if (targets.length > 0 || selection.length > 0 || event || options.size > 0)
      return "invalid-arguments";
    const path = resolve(import.meta.dir, "../../herdr");
    report({
      json,
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
  if (
    (mode === "arm" && (!owner || targets.length === 0 || root || event)) ||
    (mode === "check" &&
      (!root ||
        owner ||
        targets.length > 0 ||
        selection.length > 0 ||
        options.has("--operator-bin"))) ||
    (mode !== "arm" && mode !== "check")
  )
    return "invalid-arguments";
  const operation = mode === "arm" ? "wake_arm" : "wake_check";
  try {
    const message =
      mode === "arm"
        ? await CrewWake.arm({
            root: process.cwd(),
            owner: owner ?? "",
            targets: [...targets, ...selection],
            operatorBin: options.get("--operator-bin") ?? cliBin,
            cliBin,
            pane: process.env.HERDR_PANE_ID ?? "",
          })
        : await CrewWake.check({ root: root ?? "", event });
    report({
      json,
      result: {
        outcome: "completed",
        reason: mode === "arm" ? "wake_armed" : "wake_checked",
        blockers: [],
        operation,
        data: { message },
      },
      lines: [message],
    });
    return "reported";
  } catch (error) {
    return refuse({
      json,
      operation,
      outcome: "failed",
      reason: "wake_failed",
      detail: { message: String(error) },
      lines: [String(error)],
    });
  }
}
