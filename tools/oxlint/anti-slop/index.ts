import { eslintCompatPlugin } from "@oxlint/plugins";
import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./no-conditional-empty-object-spread.ts";
import { noReduceAccumulatorCopyRule } from "./no-reduce-accumulator-copy.ts";
import { noWidenThenAssertRule } from "./no-widen-then-assert.ts";

// Selected rules from dmmulroy/anti-slop at c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b (MIT).
export default eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
    "no-widen-then-assert": noWidenThenAssertRule,
  },
});
