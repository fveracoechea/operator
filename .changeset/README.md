# Changesets

The author of a change decides what it does to a consumer, so every change that reaches a
consumer carries a changeset.
Write one with `bun run changeset`, and let the release workflow open the version pull request.

Merging the version pull request publishes that version.
The release workflow publishes it from the merged commit after that commit passes its checks,
as described in [the release topic of the Operator skill](../skills/operator/RELEASE.md).
