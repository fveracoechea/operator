import { installSkills } from "./skills.ts";
import { applySetup, inspectSetup, recoverSetup } from "./setup.ts";
import { configJsonSchema } from "./config.ts";

export const OperatorInstallation = {
  configJsonSchema() {
    return configJsonSchema();
  },
  async installSkills(input: { projectRoot: string; targets: Array<"claude" | "opencode"> }) {
    return installSkills(input);
  },
  async inspectSetup(input: { projectRoot: string; targets: Array<"claude" | "opencode"> }) {
    return inspectSetup(input);
  },
  async recoverSetup(input: { projectRoot: string; planId: string; approvedRecoveryId?: string }) {
    return recoverSetup(input);
  },
  async applySetup(input: {
    projectRoot: string;
    targets: Array<"claude" | "opencode">;
    approvedPlanId: string;
  }) {
    return applySetup(input);
  },
};
