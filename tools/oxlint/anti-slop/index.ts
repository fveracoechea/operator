import { eslintCompatPlugin } from "@oxlint/plugins";
import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./no-conditional-empty-object-spread.ts";
import { noReduceAccumulatorCopyRule } from "./no-reduce-accumulator-copy.ts";
import { noWidenThenAssertRule } from "./no-widen-then-assert.ts";
import { noModuleMockingRule } from "./no-module-mocking.ts";
import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";
import { noReflectGetRule } from "./no-reflect-get.ts";
import { noReflectApplyRule } from "./no-reflect-apply.ts";
import { noUnknownReturnsRule } from "./no-unknown-returns.ts";
import { noObjectParametersRule } from "./no-object-parameters.ts";
import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";
import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

// The first four rules and the last four rules derive from dmmulroy/anti-slop at c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b (MIT).
// Operator implements the other rules locally, without private upstream source.
// The last four rules replace the upstream type-predicate and `cause` exemptions with the narrow validator contract of #219.
export default eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "no-module-mocking": noModuleMockingRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-reflect-get": noReflectGetRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-object-parameters": noObjectParametersRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-unknown-parameters": noUnknownParametersRule,
  },
});
