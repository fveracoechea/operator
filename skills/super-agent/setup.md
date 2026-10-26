# Device setup

Use `operator install --opencode --claude --json` for complete owned skills in both personal host locations.
Select only one host flag when needed.
Use `operator install --opencode --claude --check --json` for a content-only check.
Nix installations always check owned contents and leave consumer-owned links unchanged.
A conflict requires the person to preserve or move their edits, or change their external wiring.
Operator does not overwrite a modified skill or install permission rules.

Use `operator --help` for available settings, host selection, and project registration commands.
No project-local control file or release selection is required.
Use `operator install matt --opencode --claude --json` for an explicit global upstream install.
Select only the required host flags.
The pinned upstream installer owns replacement and its lock, and can replace local edits without an Operator preview.
Inspect failed or interrupted installs before requesting another install.

Use `operator ready --json` to check current static prerequisites for `superAgent.host` in device settings.
Resolve every returned blocker before delegated work.
The check follows skill links and requires complete owned contents and upstream `code-review` presence.
It launches no host or probe and writes no readiness record.
Slack tools are not a core prerequisite on either host.
A ready result does not prove host loading or provider access.

Every command first checks existing device-state compatibility.
Older matching history migrates automatically, after a verified backup and device-wide idle guards.
A migration blocker or failure stops the requested operation.
Resolve the reported blocker, then repeat the original command with current facts.
There is no separate migration command.
For corruption, preserve the database and the reported verified backup for the person.
Only explicit project registration creates missing workflow state.
