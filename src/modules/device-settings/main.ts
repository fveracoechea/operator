import type { OperatorHome } from "../operator-home/main.ts";
import { fromPromise, Ok, Err } from "unthrown";
import { z } from "zod";
import { apply, plan, recover, type ChangeRequest, type SettingsOutcome } from "./change.ts";
import { isIoFailure, readConfig } from "./storage.ts";
import { editorSchemaText } from "./schema.ts";
import { AgentHosts } from "../agent-hosts/main.ts";
import { selectLaunch, type SelectionRequest } from "./selection.ts";
import type { ResultContext } from "../../lib/cli-result.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;
type SettingsError = Error & { code?: unknown };
type SettingsFailure = ResultContext & {
  reason: "invalid_settings" | "settings_io_failed";
  detail: string;
};

function qualify<T>(cause: SettingsError, defect: (cause: Error) => T): SettingsFailure | T {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return {
      reason: "invalid_settings" as const,
      detail: cause.message,
      next: {
        decider: "super-agent" as const,
        question:
          "What corrected device settings should be supplied before this workflow continues?",
      },
      state: { settingsValid: false },
    };
  if (isIoFailure(cause))
    return {
      reason: "settings_io_failed" as const,
      detail: String(cause),
      next: {
        decider: "super-agent" as const,
        question:
          "How should the device settings IO failure be corrected without overwriting settings?",
      },
      state: { code: cause.code },
    };
  return defect(cause);
}

function operate(action: () => Promise<SettingsOutcome>) {
  return fromPromise(action, (cause, defect) =>
    cause instanceof Error ? qualify(cause, defect) : defect(cause),
  ).flatMap((outcome) => ("detail" in outcome ? Err(outcome) : Ok(outcome)));
}

/** Device settings never depend on the current checkout. */
export const DeviceSettings = {
  kind(input: { paths: OperatorPaths; name: string; host: "opencode" | "claude-code" }) {
    return fromPromise(
      async () => {
        const { config } = await readConfig(input.paths);
        const kind = WorkerKinds.resolve(input.name, config.kinds);
        for (const root of [
          input.paths.skillHosts[input.host],
          input.paths.upstreamSkills[input.host],
        ]) {
          const guide = `${root}/${kind.guide}`;
          if (await Bun.file(guide).exists()) return { ...kind, guide };
        }
        // oxlint-disable-next-line unthrown/no-throw -- The settings boundary qualifies a missing guide for the selected launch host.
        throw new SyntaxError(
          `Kind ${input.name}: No installed guide skill for ${input.host}: ${kind.guide}.`,
        );
      },
      (cause, defect) =>
        cause instanceof Error || cause instanceof z.ZodError
          ? qualify(cause, defect)
          : defect(cause),
    );
  },
  resolve(input: SelectionRequest & { paths: OperatorPaths; cwd: string }) {
    return fromPromise(
      () => readConfig(input.paths),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    )
      .flatMap(({ config }) => {
        const selected = selectLaunch(config, input);
        if ("reason" in selected) return Err(selected);
        return Ok(selected);
      })
      .flatMap((selected) =>
        AgentHosts.resolve({ ...selected, cwd: input.cwd }).map((resolved) => ({
          ...resolved,
          role: selected.role,
          profile: selected.profile,
        })),
      );
  },
  show(paths: OperatorPaths) {
    return fromPromise(
      async () => ({
        reason: "settings_read",
        data: await readConfig(paths),
      }),
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
  plan(request: ChangeRequest) {
    return operate(() => plan(request));
  },
  apply(request: ChangeRequest) {
    return operate(() => apply(request));
  },
  recover(paths: OperatorPaths) {
    return operate(() => recover(paths));
  },
  /**
   * The registered repositories and GitHub authors eligible for manual review requests.
   */
  reviewPolicy(paths: OperatorPaths) {
    return fromPromise(
      async () => {
        const review = (await readConfig(paths)).config.review;
        return { repos: review?.repos ?? [], authors: review?.authors ?? [] };
      },
      (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
    );
  },
  /** The settings editor schema that a release ships and a settings edit writes. */
  editorSchema() {
    return editorSchemaText();
  },
};
