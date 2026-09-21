# Prepare a project for Operator

## Install the Operator skills

Give at least one target.
The CLI does not guess the target from the agents it finds.

```sh
operator install --opencode
operator install --claude
operator install --opencode --claude
```

Each target receives a complete copy of every Operator-owned skill.
A copy that already matches is adopted without a write.
A copy the user changed is a conflict.
The command then writes nothing and reports the conflicting paths.

## Configure the project

Setup inspects the project and prints the exact changes it proposes.
It writes nothing until you give back the same plan identifier.

```sh
operator setup plan --claude --json
operator setup apply --claude --approved-plan <planId> --json
```

The plan identifier covers the selected targets and the exact content of every proposed change.
A changed project or a changed target produces a new identifier, and the old approval is refused.

An unchanged rerun proposes no changes and writes nothing.

A plan reports a conflict, and writes nothing, when Operator files are already tracked by Git, when the existing configuration is invalid, when the marked Operator instruction section was changed, or when an installed skill copy differs from this release.

Setup owns these files:

- `.operator/config.json`, created only when it is missing.
- `.operator/config.schema.json`, the editor schema for the configuration.
- `.gitignore`, which receives one marked block that ignores `/.operator/`.
- `AGENTS.md`, which receives one marked Operator section.
- `CLAUDE.md`, which receives an `@AGENTS.md` import when the Claude Code target is selected.

Setup never commits, never changes the Git index, and never installs machine-wide software.

## Recover an interrupted setup

```sh
operator setup rollback --json
```

Setup records each completed write and the previous contents of the file.
Rollback restores only the files that still hold what setup wrote.
A file the user changed afterwards is preserved and reported as a conflict.

Apply refuses to start while a recovery record is pending.
Roll back first, then plan and apply again.
