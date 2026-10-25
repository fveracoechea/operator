import { Environment } from "../modules/environment/main.ts";

const userAgent = Environment.read().npm_config_user_agent;

if (!userAgent?.startsWith("bun/")) {
  console.error("Operator dependencies must be installed with Bun.");
  process.exitCode = 1;
}
