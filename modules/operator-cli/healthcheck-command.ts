import { GithubApi } from "../github-api/main.ts";
import { HerdrControl } from "../herdr-control/main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import { targetFlag, type ParsedArguments } from "./arguments.ts";
import { reportMissingTarget } from "./missing-target.ts";
import { blockerData, reportLines } from "./readiness-command.ts";
import { report } from "./result.ts";

type Connection = { state: "passed" | "failed"; detail: string; nextAction: string | null };

/** Reads the Herdr server and GitHub identity without creating resources or writing to a fixture. */
export async function runHealthcheck(parsed: ParsedArguments): Promise<void> {
  if (parsed.targets.length === 0) {
    reportMissingTarget(parsed, "healthcheck");
    return;
  }

  const readiness = await ProjectReadiness.check({
    projectRoot: process.cwd(),
    targets: parsed.targets,
    overrides: parsed.overrides,
  });
  const [herdr, github, plugin] = await Promise.all([
    HerdrControl.connection({ repoRoot: process.cwd() }),
    GithubApi.connection(readiness.fixture),
    HerdrControl.wakePlugin(readiness.versions.herdr ?? "missing"),
  ]);
  const connections: Record<"herdr" | "github" | "wake-plugin", Connection> = {
    herdr,
    github,
    "wake-plugin": plugin,
  };
  const failures = Object.entries(connections).filter(([, value]) => value.state === "failed");
  const dispatch = readiness.state === "ready" ? "allowed" : "blocked";
  const stale = readiness.unproven.filter((one) => one.state === "stale").map((one) => one.name);
  const overrides = (["operator", "crew"] as const).flatMap((role) => [
    ...(readiness.selection[role].hostSource === "session-override"
      ? [`--${role}-host ${readiness.selection[role].host}`]
      : []),
    ...(readiness.selection[role].modelSource === "session-override"
      ? [`--${role}-model ${readiness.selection[role].model}`]
      : []),
  ]);
  const selectionFlags = [...parsed.targets.map(targetFlag), ...overrides].join(" ");
  const reproof =
    stale.length > 0
      ? `Run \`operator setup probe plan ${selectionFlags} --stale-only\`, then apply the approved plan to reprove ${stale.join(", ")}.`
      : null;

  report({
    json: parsed.json,
    result: {
      outcome:
        readiness.state === "ready" && failures.length === 0 ? "completed" : "missing-condition",
      reason:
        failures.length > 0 || readiness.state === "blocked"
          ? "healthcheck_blocked"
          : readiness.state === "unverified"
            ? "healthcheck_unverified"
            : "healthcheck_passed",
      blockers: [
        ...readiness.blockers.map((one) => blockerData(one, "readiness_blocked")),
        ...readiness.unproven.map((one) => blockerData(one, "readiness_unverified")),
        ...failures.map(([name, value]) => ({
          reason: "healthcheck_connection_failed" as const,
          check: `${name}-connection`,
          detail: value.detail,
          nextAction: value.nextAction,
        })),
      ],
      operation: "healthcheck",
      data: { readiness, connections, dispatch: { state: dispatch, gate: "readiness" }, reproof },
    },
    lines: [
      "Operator healthcheck (read-only)",
      `Dispatch: ${dispatch}. The readiness claim must be proven before a new attempt can dispatch.`,
      `Herdr connection: ${herdr.state}. ${herdr.detail}`,
      ...(herdr.nextAction ? [`  Next: ${herdr.nextAction}`] : []),
      `GitHub access: ${github.state}. ${github.detail}`,
      ...(github.nextAction ? [`  Next: ${github.nextAction}`] : []),
      `Herdr wake plugin: ${plugin.state}. ${plugin.detail}`,
      ...(plugin.nextAction ? [`  Next: ${plugin.nextAction}`] : []),
      "A connected host and an authenticated GitHub client do not prove model answers, review agents, termination, or tracker writes.",
      "",
      ...reportLines(readiness),
      ...(reproof ? ["", reproof] : []),
      `The full compatibility probe needs separate approval. Run \`operator setup probe plan ${selectionFlags}\`, then use its approved apply command.`,
    ],
  });
}
