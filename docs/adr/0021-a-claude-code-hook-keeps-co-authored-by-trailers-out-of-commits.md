# ADR-0021: A Claude Code hook keeps Co-Authored-By trailers out of commits

## Status

Accepted - 2026-10-31.
Amended 2026-11-04: the same hook also guards a SuperAgent's turn end on the Stop event, and only that branch reads device state (ADR-0022).
The Stop branch is implemented in #325.

## Context

The person's global agent instructions told every agent to write commits with no Co-Authored-By trailer.
A Claude Code system reminder can ask for the trailer, and a rule in a context file is only a suggestion.
The person asked for the rule to move out of the instructions and into a Claude Code hook that runs through the Operator CLI.

## Decision

`operator claude hook` is Operator's Claude Code hook.
It reads one hook event on standard input and denies a Bash `git commit` whose message carries a Co-Authored-By trailer.
The deny reason tells the agent to remove the trailer and commit again.
It never allows a tool, so Claude Code keeps its own permission flow.
The commit check reads no device state, so it runs before the state compatibility check and works on a device with blocked or missing state.
The same hook also handles the Stop event as the turn-end guard of ADR-0022, which reads device state and allows the stop when that state is unusable.

The hook acts before the commit, through `PreToolUse`.
A `PostToolUse` check would find the trailer only after the commit exists, and would need a history rewrite to fix it.
The hook reads the message from the command text, which holds `-m` values, heredocs, and `--trailer` values, and from a `-F` file.
A message from an editor, from `--no-edit`, or from a reused commit is not in the command, so the hook allows it.
An agent cannot use an editor, and a reused message passed the hook when it was first written.

`operator install --claude` adds one `PreToolUse` group to the person's Claude Code user settings, after the groups that the person has, and one `Stop` group for the turn-end guard.
The `PreToolUse` group matches Bash and filters on `Bash(git *)`, so the hook does not start on other commands.
A settings file that already runs the hook command in a group for each event is installed, and the file stays unwritten.
A file that has only one of the groups gets the missing one.
Check mode, a Nix release, and readiness only read the settings.
A linked or read-only settings file belongs to its owner, such as a dotfiles repository, as linked skills do in ADR-0008.
Operator then refuses the write and names the exact groups to add.

The hook is not a permission rule in the sense of ADR-0014.
It grants nothing and passes no permission mode. It only denies one kind of commit message that the person asked to keep out, and blocks a SuperAgent's turn end once.

## Consequences

- A device whose Claude Code settings live in a dotfiles repository is not ready until the person adds both groups to that repository.
- An agent can still commit a trailer through an editor message, a reused commit, or a command that hides the message from the hook.
  The hook is a nudge, and there is no CI check of commit trailers.
- A hook that cannot read its event exits 1, and Claude Code runs the command. A broken hook fails open.
- Install rewrites the settings file with two-space JSON formatting.
- OpenCode reads the same global instructions and now has no rule against the trailer. OpenCode gets no hook in this decision.

## Alternatives considered

- Claude Code's native `attribution` setting, which replaces the deprecated `includeCoAuthoredBy`, was not chosen.
  It changes the trailer that Claude Code suggests, but it does not stop a trailer that a reminder, a skill, or the model adds.
  It can complement the hook, and Operator does not set it.
- A `PostToolUse` check of the new commit was rejected because it finds the trailer only after the commit exists.
- A Git `commit-msg` hook was rejected because it needs per-repository or global Git configuration that Operator does not own, and it would also stop the person's own commits.
- Writing through a linked settings file was rejected because the link target belongs to the person's dotfiles.
- A rule in the global agent instructions was rejected because the agent can skip it, and it costs context on every run.

Related: ADR-0022, the turn-end guard shares this hook; ADR-0008, consumer-owned links stay unchanged; ADR-0009, readiness checks static facts; ADR-0014, Operator installs no permission rules.
