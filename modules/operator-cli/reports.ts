import { ReportAssignments } from "../report-assignments/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

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

function exitCode(reason: string) {
  if (reason === "invalid_report_input") return 2;
  if (["report_io_failed", "state_busy", "state_io_failed", "project_io_failed"].includes(reason))
    return 1;
  if (
    [
      "controller_mismatch",
      "controller_identity_mismatch",
      "report_changed",
      "self_decision_refused",
      "worker_launch_not_found",
    ].includes(reason)
  )
    return 4;
  return 3;
}

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
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err")
    failure(
      operation,
      result.error.reason,
      result.error.detail,
      exitCode(result.error.reason),
      json,
    );
  else failure(operation, "report_defect", String(result.cause), 1, json);
  return true;
}
