---
"@fveracoechea/operator": patch
---

Add reusable OpenCode v2 `super` and `worker` Markdown agents under `agents/opencode/`.
Each mode loads its matching Operator skill before other tool calls.
Shared prompts and permissions replace the inline SuperAgent configuration while dotfiles retain machine-specific model overrides.
