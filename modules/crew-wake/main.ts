import { arm } from "./arm.ts";
import { check } from "./check.ts";

/** Coordinates a one-shot Herdr wake without making any crew mutation. */
export const CrewWake = {
  async arm(request: Parameters<typeof arm>[0]) {
    return arm(request);
  },
  async check(request: Parameters<typeof check>[0]) {
    return check(request);
  },
};
