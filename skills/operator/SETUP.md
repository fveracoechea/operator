# Prepare a project for Operator

## Install the Operator skills

Give at least one target.
The CLI does not guess the target from the agents it finds.

```sh
bun run operator install --opencode
bun run operator install --claude
bun run operator install --opencode --claude
```

Each target receives a complete copy of every Operator-owned skill.
A copy that already matches is adopted without a write.
A copy the user changed is a conflict.
The command then writes nothing and reports the conflicting paths.

## Install Matt Pocock skills

Plan and approve the upstream skills before you create Operative worktrees.
Commit the installed project skills so new worktrees contain `code-review`.

```sh
bun run operator install matt plan --opencode --claude --json
bun run operator install matt apply --opencode --claude --commit <commit> --approved-plan <planId> --json
```

The plan resolves the current `mattpocock/skills` `main` commit.
Authenticate `gh` before you run it.
"Latest" means that pinned commit, not the moving branch at apply time.
Apply verifies the fetched files and refuses stale approval or local edits.
The plan selects skills from the pinned upstream tree.
Upstream `unslop` and `cursor` are excluded.
The target's `.operator-matt-skills.json` records content hashes for later updates.
To update the skills, run `bun run operator install matt plan` again and apply the new plan.

## Configure the project

Setup inspects the project and prints the exact changes it proposes.
It writes nothing until you give back the same plan identifier.

```sh
bun run operator setup plan --claude --json
bun run operator setup apply --claude --approved-plan <planId> --json
```

The plan identifier covers the selected targets and the exact content of every proposed change.
A changed project or a changed target produces a new identifier, and the old approval is refused.

An unchanged rerun proposes no changes and writes nothing.

Never repair a conflict by overwriting a file the user changed.
Report the conflict and ask.

A plan reports a conflict, and writes nothing, when Operator files are already tracked by Git, when the existing configuration is invalid, when the marked Operator instruction section was changed, or when an installed skill copy differs from this release.
A marked section that an earlier release wrote is not a conflict, and the plan proposes the section of this release in its place.

Setup owns these files:

- The project configuration, created only when it is missing.
- The editor schema for the configuration, which an editor reads to check it.
- `.gitignore`, which receives one marked block that ignores `/.operator/`.
- `AGENTS.md`, which receives one marked Operator section.
- `CLAUDE.md`, which receives an `@AGENTS.md` import when the Claude Code target is selected.

Setup never commits, never changes the Git index, and never installs machine-wide software.

## Change project settings

Read the validated settings with `bun run operator config show --json`.
To change a setting, run `bun run operator config plan --set <path=value> --json`, show its exact file change to the user, then run `bun run operator config apply` with the same flags and `--approved-plan <planId>`.
Use `--unset <path>` to remove a setting and return to its default.
The CLI usage lists supported fields.
Run `bun run operator config recover --json` if an apply was interrupted.
Recovery compares the file with the recorded before and after identities and changes no configuration value.

## Select the release

A configured project is not yet coordinating with a known release.
Read [RELEASE.md](RELEASE.md) before you select one, update one, or answer a `state_version_outdated` refusal.

## Recover an interrupted setup

```sh
bun run operator setup rollback --json
```

Setup records each completed write and the previous contents of the file.
Rollback restores only the files that still hold what setup wrote.
A file the user changed afterwards is preserved and reported as a conflict.

Apply refuses to start while a recovery record is pending.
Roll back first, then plan and apply again.
