import { eslintCompatPlugin } from "@oxlint/plugins";
import { envThroughSchemaRule } from "./env-through-schema.ts";

export default eslintCompatPlugin({
  meta: { name: "operator" },
  rules: { "env-through-schema": envThroughSchemaRule },
});
