import { openWakeState } from "./database.ts";
import { bindings } from "./schema.ts";

/** Owns the plugin binding database and the CLI paths used by its Herdr launcher. */
export const WakeState = {
  async open(dir: string) {
    return openWakeState(dir);
  },
  table() {
    return bindings;
  },
};
