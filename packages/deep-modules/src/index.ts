// Stryker disable all: no logic
import { eslintCompatPlugin } from "@oxlint/plugins";
import { moduleInterfaceRule } from "./module-interface.ts";
import { moduleImportsRule } from "./module-imports.ts";
import { libImportsRule } from "./lib-imports.ts";
import { publicCollaboratorMocksRule } from "./public-collaborator-mocks.ts";
import { queryOptionsOwnerRule } from "./query-options-owner.ts";
import { synchronousSelectorsRule } from "./synchronous-selectors.ts";

export default eslintCompatPlugin({
  meta: { name: "deep-modules" },
  rules: {
    "module-interface": moduleInterfaceRule,
    "module-imports": moduleImportsRule,
    "lib-imports": libImportsRule,
    "public-collaborator-mocks": publicCollaboratorMocksRule,
    "query-options-owner": queryOptionsOwnerRule,
    "synchronous-selectors": synchronousSelectorsRule,
  },
});
