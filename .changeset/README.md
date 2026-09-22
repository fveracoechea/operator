# Changesets

The author of a change decides what it does to a consumer, so every change that reaches a
consumer carries a changeset.
Write one with `bun run changeset`, and let the release workflow open the version pull request.

Nothing here publishes anything.
Publication is a separate approved action against one exact merged and checked commit, described
in [the release topic of the Operator skill](../skills/operator/RELEASE.md).
