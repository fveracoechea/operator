import { eslintCompatPlugin } from "@oxlint/plugins";
import { noFixtureAssertionRule } from "./no-fixture-assertion.ts";

export default eslintCompatPlugin({
  meta: { name: "custom-tests" },
  rules: { "no-fixture-assertion": noFixtureAssertionRule },
});
