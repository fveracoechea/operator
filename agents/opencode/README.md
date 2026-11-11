# OpenCode modes

Install `super.md` and `worker.md` in `~/.config/opencode/agents/` for global use.
Use `.opencode/agents/` for a project-only installation.
These files use the native OpenCode v2 agent and permission formats.

Select `super` to supervise Operator work.
Select `worker` only with an absolute Operator brief in the initial prompt.
Both modes run as primary agents because Operator dispatches workers into separate panes, not native child sessions.
Each mode loads its matching installed skill before other tool calls.
The skills remain the source of truth for the workflow.

The files omit models so each configuration can choose its own.
Set `agents.super.model` and `agents.worker.model` in `opencode.json` when a machine needs explicit model preferences.
Keep only machine-specific overrides there, rather than duplicating these prompts or permissions.

SuperAgent can edit coordination files under `/tmp/operator-plans/` and answers under `/tmp/operator-answers/`.
The `/private/tmp/` aliases support macOS path normalization.
Its permissions block native delegation and common implementation commands.
Both agents route questions through their skills rather than OpenCode's blocking question tool.
Permissions prevent accidental tool use, but do not sandbox the allowed shell commands.

Dotfiles can pin these Markdown files independently of the Operator CLI release.
Installing a mode does not install its required skill or change Operator device state.
