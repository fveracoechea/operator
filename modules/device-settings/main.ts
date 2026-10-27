import type { OperatorHome } from "../operator-home/main.ts";
import { fromPromise, Ok, Err } from "unthrown";
import { z } from "zod";
import { apply, plan, recover, type ChangeRequest, type SettingsOutcome } from "./change.ts";
import { isIoFailure, readConfig } from "./storage.ts";
import { editorSchemaText } from "./schema.ts";
import { AgentHosts } from "../agent-hosts/main.ts";
import { selectLaunch, type SelectionRequest } from "./selection.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

function qualify<T>(cause: unknown, defect: (cause: unknown) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "invalid_settings" as const, detail: cause.message };
  if (isIoFailure(cause)) return { reason: "settings_io_failed" as const, detail: String(cause) };
  return defect(cause);
}

function operate(action: () => Promise<SettingsOutcome>) {
  return fromPromise(action, qualify).flatMap((outcome) =>
    "detail" in outcome ? Err(outcome) : Ok(outcome),
  );
}

/** Device settings never depend on the current checkout. */
export const DeviceSettings = {
  resolve(input: SelectionRequest & { paths: OperatorPaths; cwd: string }) {
    return fromPromise(() => readConfig(input.paths), qualify)
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
      qualify,
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
  /** The settings editor schema that a release ships and a settings edit writes. */
  editorSchema() {
    return editorSchemaText();
  },
};
