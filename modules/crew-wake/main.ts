import { arm } from "./arm.ts";
import { check } from "./check.ts";
import { WakeBinding } from "./binding.ts";
import { pluginHealth } from "./plugin.ts";

/** Coordinates a one-shot Herdr wake without making any crew mutation. */
export const CrewWake = {
  async arm(request: Parameters<typeof arm>[0]) {
    return arm(request);
  },
  async check(request: Parameters<typeof check>[0]) {
    return check(request);
  },
  /**
   * Pure. The wake binding machine: `absent | armed | submitted | stale`, moved by `arm`,
   * `check`, `herdr-event`, and `ownership-changed`. It gives the next state, a refusal, or the
   * next fact it needs to read.
   */
  decide(...request: Parameters<typeof WakeBinding.decide>) {
    return WakeBinding.decide(...request);
  },
  /** Reads whether the installed Herdr plugin is this release's wake plugin. */
  async pluginHealth(herdrVersion: string) {
    return pluginHealth(herdrVersion);
  },
};
