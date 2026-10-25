import type { OperatorHome } from "../operator-home/main.ts";
import { fromPromise, Ok, Err } from "unthrown";
import { z } from "zod";
import { apply, plan, recover, type ChangeRequest, type SettingsOutcome } from "./change.ts";
import { isIoFailure, readConfig } from "./storage.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

function operate(action: () => Promise<SettingsOutcome>) {
  return fromPromise(action, (cause, defect) => {
    if (cause instanceof SyntaxError || cause instanceof z.ZodError)
      return { reason: "invalid_settings" as const, detail: cause.message, exitCode: 2 as const };
    if (isIoFailure(cause)) {
      return { reason: "settings_io_failed" as const, detail: String(cause), exitCode: 1 as const };
    }
    return defect(cause);
  }).flatMap((outcome) => (outcome.exitCode === 0 ? Ok(outcome) : Err(outcome)));
}

/** Device settings never depend on the current checkout. */
export const DeviceSettings = {
  show(paths: OperatorPaths) {
    return operate(async () => ({
      reason: "settings_read",
      data: await readConfig(paths),
      exitCode: 0,
    }));
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
};
