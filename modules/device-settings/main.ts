import type { OperatorHome } from "../operator-home/main.ts";
import { fromPromise, Ok, Err } from "unthrown";
import { z } from "zod";
import { apply, plan, recover, type ChangeRequest, type SettingsOutcome } from "./change.ts";
import { isIoFailure, readConfig } from "./storage.ts";

type OperatorPaths = ReturnType<typeof OperatorHome.resolve>;

function operate(action: () => Promise<SettingsOutcome>) {
  return fromPromise(action, (cause, defect) => {
    if (cause instanceof SyntaxError || cause instanceof z.ZodError)
      return { reason: "invalid_settings" as const, detail: cause.message };
    if (isIoFailure(cause)) {
      return { reason: "settings_io_failed" as const, detail: String(cause) };
    }
    return defect(cause);
  }).flatMap((outcome) => ("detail" in outcome ? Err(outcome) : Ok(outcome)));
}

/** Device settings never depend on the current checkout. */
export const DeviceSettings = {
  show(paths: OperatorPaths) {
    return operate(async () => ({
      reason: "settings_read",
      data: await readConfig(paths),
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
