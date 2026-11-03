---
"@fveracoechea/operator": patch
---

The `worker-agent` and `super-agent` skills and the PR brief now allow only `gh stack view --json` from the gh-stack extension.
The relay and `operator pr merge` own every rebase, push, base change, and merge of a stack, so another `gh stack` command would race them.
