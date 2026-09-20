const userAgent = Bun.env.npm_config_user_agent;

if (!userAgent?.startsWith("bun/")) {
  console.error("Operator dependencies must be installed with Bun.");
  process.exitCode = 1;
}
