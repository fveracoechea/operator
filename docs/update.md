# Update Operator

Follow these steps to move a device to a new Operator release.
An agent or a person can run them.
The device is updated when `operator ready --json` returns `"reason": "ready"` on the new version.

One installed release serves every project on the device, so one update covers all projects.
The first command of the new release migrates device state when the release ships a migration.
ADR-0007 records this decision.

## 1. Make the device idle

A migration runs only on an idle device.
The device is idle when these conditions are true in every registered project:

- No assignment is `running`, `pr-open`, or `reported`.
- No reviewer is reviewing or posting a review.
- No worker launch, worktree preparation, cleanup, or project removal is in progress.

Finish or reset that work with the release that started it.
Read the [changelog](../CHANGELOG.md) for each version between the current and the new release.
A `Major Changes` section names each breaking change.

The step is done when the device is idle and you know the target version.

## 2. Install the new release

Use the same install method as before.
Record the current version from `operator --version --json`, so you can install it again if you must.

### JSR with Bun

Install the latest release:

```sh
bun add -g --exact "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@latest"
```

To pin a specific release, replace `latest` with the version, for example `1.2.0`:

```sh
bun add -g "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@1.2.0"
```

Keep the exact version.
`operator ready` reports `installation_unpinned`, and `operator install launcher` refuses with `launcher_version_unpinned`, when the global manifest names a range.

### Repository source

Install the new full 40-character commit:

```sh
bun add -g "git+https://github.com/fveracoechea/operator.git#<full-commit>"
```

Bun links the `operator` command again, so this method needs no launcher.

### Nix flake

Operator never edits your Nix configuration.
Change these items yourself:

1. Set the new tag in the flake input, for example `github:fveracoechea/operator/v1.2.0`.
2. Run `nix flake update operator` to lock the new tag.
3. Rebuild your configuration.

When your skill links come from `operator.skills`, as in the README example, the rebuild links the skills of the new release.
When you list skill names yourself, add each new skill and remove each renamed or removed skill.
Operator does not change or repair these links.

Operator CI does not build the Nix package, so a release tag can fail to build.
If the build of a release tag fails, open an issue in `fveracoechea/operator` with your system and the build log.

## 3. Confirm the version

Run:

```sh
operator --version --json
```

The step is done when `data.operatorVersion` is the target version.
This first command also applies pending state migrations, after it writes a verified backup.
If it refuses, go to [Refusals](#refusals).

## 4. Update the skills and the Herdr plugin

Run these commands in this order.
Give `install` the flag of each host that your settings select, as `operator config show --json` reports.

1. JSR only: run `operator install launcher --json`.
   It returns `launcher_current` when the launcher already runs the global package.
2. Run `operator install --opencode --claude --json`.
   On JSR and source installs, it replaces unchanged copies of the owned skills with the new release's contents.
   It returns `skills_installed`, or `skills_already_installed` when the contents already match.
   On Nix, it only checks your links and returns `skills_checked`.
3. Run `operator herdr install --json`.
   It returns `herdr_plugin_updated` when the release changed the plugin manifest, and `herdr_plugin_unchanged` otherwise.
   A dispatch refuses with `herdr_plugin_outdated` until you run this command.

The step is done when each command returns one of the reasons above.

## 5. Check readiness

Run:

```sh
operator ready --json
```

The step is done when the result has `"reason": "ready"` and an empty `blockers` list.

`ready` checks that the owned skills match the new release.
It checks only that the required Matt Pocock skills exist, not their revision.
Run `operator install matt` with the same host flags only when `ready` reports `upstream_skills_missing`.

A running host session keeps the skills that it loaded at its start.
Start a new SuperAgent session after the update.

## Refusals

Every refusal names a `reason` and a `detail`.
Read the `detail` first, because it names the path or the command to fix.

| Reason | Cause | Action |
| --- | --- | --- |
| `state_migration_blocked` | Active work holds the migration. Every command refuses, also `--version`. | Install the previous release again. Finish that work, then update again. |
| `state_incompatible` | The device state is newer than the running release, or its history is unknown. | Install the release that last migrated the state, or a later one. |
| `state_backup_failed` | The backup before the migration failed. Nothing was migrated. | Fix the cause in `detail`, then run the command again. |
| `state_corrupt` | The device database failed its integrity check. | Stop. Give the person the backup path in `detail`. Operator does not repair state. |
| `unsupported_bun` | Bun is older than the release requires. | Update Bun to the `required` version, then run the command again. |
| `installation_unpinned`, `launcher_version_unpinned` | The global manifest names a range, not an exact version or commit. | Install again with an exact version or a full commit. |
| `executable_missing` for `operator` | The `operator` command is not on `PATH`. | JSR: run `install launcher`. Source and Nix: put the bin folder on `PATH`. |
| `executable_mismatch` | The `operator` command on `PATH` runs another release. | Remove or replace that command, then install the launcher or the source package again. |
| `launcher_conflict` | Another file is at the launcher path. | Give the path to the person. Operator does not replace it. |
| `skill_copy_conflict` | A skill copy has local edits, or a Nix link points to other contents. | JSR and source: keep the edits elsewhere, then remove the copy and install again. Nix: fix the link and rebuild. |
| `skills_missing` | A skill of the new release has no link or copy. | JSR and source: run `install` without `--check`. Nix: add the link and rebuild. |
| `upstream_skills_missing` | A required Matt Pocock skill is missing. | Run `operator install matt` with the host flags. |
| `herdr_plugin_conflict` | Herdr links another directory under the Operator plugin id. | Give the linked directory to the person. Operator does not replace it. |
| `herdr_plugin_outdated`, `herdr_plugin_missing` | A dispatch found a plugin manifest from another release, or none. | Run `operator herdr install`. |

A `state_migration_blocked` refusal changes no state.
The previous release still reads the device state, so you can install it again with its exact version or commit.
After a migration completes, an older release refuses with `state_incompatible`.
