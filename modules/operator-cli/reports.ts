import { ReportAssignments } from "../report-assignments/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

const commands = {
  submit: ["--file"],
  resume: [],
  accept: ["--source", "--assignment"],
  return: ["--source", "--assignment", "--file"],
} as const;

function commandOf(value: string | undefined) {
  return value === "submit" || value === "resume" || value === "accept" || value === "return"
    ? value
    : null;
}

function reportFlags(flags: string[], required: readonly string[]) {
  const values: Record<string, string> = {};
  let json = false;
  const rest = flags.values();
  for (const flag of rest) {
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }
    const value = rest.next().value;
    if (
      !required.includes(flag) ||
      Object.hasOwn(values, flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      return null;
    values[flag] = value;
  }
  return required.every((flag) => Object.hasOwn(values, flag)) ? values : null;
}

export function reportArgs(args: string[]) {
  const [group, name, ...flags] = args;
  const command = group === "report" ? commandOf(name) : null;
  if (command === null) return null;
  const values = reportFlags(flags, commands[command]);
  if (values === null) return null;
  return {
    command,
    file: values["--file"] ?? "",
    sourceId: values["--source"] ?? "",
    assignment: values["--assignment"] ?? "",
  };
}

const reportExitCodes = {
  invalid_report_input: 2,
  report_io_failed: 1,
  report_changed: 4,
  self_decision_refused: 4,
  worker_launch_not_found: 4,
};

export async function runReports(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = reportArgs(args);
  if (parsed === null) return false;
  const selected = { paths, cwd: process.cwd(), ...parsed };
  const result = await (parsed.command === "submit"
    ? ReportAssignments.submit(selected)
    : parsed.command === "resume"
      ? ReportAssignments.resume(selected)
      : parsed.command === "accept"
        ? ReportAssignments.accept(selected)
        : ReportAssignments.return(selected));
  const operation = `report_${parsed.command}`;
  respond({ operation, result, exitCodes: reportExitCodes, defect: "report_defect", json });
  return true;
}
