# Select a release, update a project, and publish

## Select the release a project coordinates with

Coordinated work has to run one known release.
Until a project selects one, readiness stays unverified and `operator crew next` asks for this first.

```sh
operator update plan --claude --commit <full-commit> --json
operator update apply --claude --commit <full-commit> --approved-update <updateId> --json
```

The commit is the full commit of the release that is running, not a short one and not a branch.
A registry installation also names the exact published version:

```sh
operator update plan --claude --delivery jsr --commit <full-commit> --package-version <version> --json
```

The update identifier covers the release it moves to, the skills it would write, the recorded formats it would migrate, and the records it would back up.
A change to any of them makes a new identifier, and the old approval is refused.

`apply` reports the exact command the project runs Operator with.
Give that command to the user; Operator never retrieves a package itself.

## What an update refuses

Nothing is written when the commit, or the published version, is not the one the running release
carries.
A retrieved release records the commit it was built from, so the update reads that record instead
of trusting the flag.
A checkout carries no such record, and nothing is checked against a record that does not exist.

Nothing is written while the crew still has work in flight.
Finish, accept, or invalidate that work first, then plan again.

Nothing is written when an installed skill copy differs from this release.
Restore or remove the changed copy.
Never repair it by overwriting what the user changed.

Nothing is migrated until every durable record is copied aside and read back.
A copy that did not read back as written stops the update before anything moves.

A migration step that cannot finish puts the backed-up records back exactly as they were, and reports what it restored.
A recorded format this release has no step for is reported, never repaired in silence.

## When the crew state is older than the release

Every crew command refuses a state file an earlier release wrote, with `state_version_outdated`.
That is the signal to run the update above, not to delete the file.

A state file a newer release wrote is refused with `state_version_unsupported`.
Install the newer Operator; this one cannot read it.

## Publish

You have no authority to publish, and you never run the publication yourself.
The release workflow publishes a version after its version pull request merges, from the merged commit, once that commit passed the quality gate and the release smoke.
Merging that pull request is the user's decision, not yours.

To report what the publication would do, run the plan:

```sh
bun scripts/release.ts plan --out dist --commit <full-commit>
```

The plan refuses a commit that is not merged into the release branch, a tag that already names another commit whose release is not complete, and a version the registry already holds with no record of this release.
It reports a version both paths already hold as `released`, and then nothing is published.
Changed content is a new version, never a replacement.

A partial publication is not repaired by hand.
Ask the user to run the failed publish job again; it delivers only the path that is still missing and leaves the delivered one alone.
