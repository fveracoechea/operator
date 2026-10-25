import { Environment } from "../modules/environment/main.ts";

// Every test uses the same validated environment boundary. Child environments are explicit.
if (Environment.read().NODE_ENV !== "test") {
  // oxlint-disable-next-line unthrown/no-throw -- The real-root guard requires Bun's test mode.
  throw new Error("Tests require NODE_ENV=test so the Operator-home guard stays active.");
}
