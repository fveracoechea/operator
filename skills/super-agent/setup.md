# Device setup

Operator runs through the global `operator` command on `PATH`, for agents, shells, and Herdr hooks.
The person installs one exact JSR version or one full source commit with `bun add -g`, or the Nix flake at a release tag.
A JSR install has no command until its package CLI runs `install launcher --json` once, after registration.
A source install gets its command from Bun, and a Nix install from its package.
Do not install or select a release inside a project.

After each install or update of the release, use `operator install --opencode --claude --json`.
It copies complete owned skills into both personal host locations, then installs the upstream skills globally: Matt Pocock's productivity and engineering skills, `unslop`, and `show-me`.
Select only one host flag when needed.
Use `operator install --opencode --claude --check --json` for a content-only check of owned skills. It installs no upstream skills.
Nix installations always check owned contents and leave consumer-owned links unchanged, and they still install the upstream skills.
An owned conflict stops the command before the upstream install.
A conflict requires the person to preserve or move their edits, or change their external wiring.
Operator does not overwrite a modified owned skill or install permission rules.
The pinned upstream installer owns upstream replacement and its lock, and can replace local edits without an Operator preview.
Inspect failed or interrupted installs before requesting another install.

Use `operator ready --json` to check current static prerequisites, including a pinned global command that runs this release, for every host that device settings select.
Resolve every returned blocker before delegated work.
The check follows skill links and requires complete owned contents and upstream `code-review` presence.
It launches no host or probe and writes no readiness record.
Slack tools are not a core prerequisite on either host. Only the Slack review workflow needs them, on Claude Code.
A ready result does not prove host loading or provider access.

Every command first checks existing device-state compatibility.
Older matching history migrates automatically, after a verified backup and device-wide idle guards.
A migration blocker or failure stops the requested operation.
Resolve the reported blocker, then repeat the original command with current facts.
There is no separate migration command.
For corruption, preserve the database and the reported verified backup for the person.
Only explicit project registration creates missing workflow state.

Use `operator project list --json` from any directory to inspect controllers, open-source counts, and pending removals.
To move a controller, run `operator project move --json` from a main clone with the same remote identity and no open source.
Several remote identities require `--repository owner/repository`.
Run `operator project remove owner/repository --person-instructed --json` only on the person's explicit instruction.
The flag attests that instruction and never replaces it.
Removal requires no open source and deletes Operator history without touching repository work or migration backups.
If cleanup remains pending, preserve external content, resolve the reported filesystem problem, and repeat that removal.
Re-registration stays blocked until cleanup completes.
