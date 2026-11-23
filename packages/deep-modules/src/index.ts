// Stryker disable all: no logic
import { eslintCompatPlugin } from "@oxlint/plugins";
import { moduleInterfaceRule } from "./module-interface.ts";

export default eslintCompatPlugin({
  meta: { name: "deep-modules" },
  rules: { "module-interface": moduleInterfaceRule },
});
