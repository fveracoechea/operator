import { defineConfig } from "drizzle-kit";
import { Environment } from "./modules/environment/main.ts";
import { OperatorHome } from "./modules/operator-home/main.ts";

/** Drizzle Studio reads the device database of the person who runs it. */
export default defineConfig({
  dialect: "sqlite",
  schema: "./modules/device-state/schema.ts",
  dbCredentials: { url: OperatorHome.resolve(Environment.read()).database },
});
