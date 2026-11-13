# Obligations

An obligation is something you owe the person in a source. Record it the moment you take it on, because your conversation does not survive and Operator state does.
`operator next` shows each open obligation in the source's `owed` list until you close it. Read `owed` on every wake, and act on each item that the new facts make due.
An obligation is not an action, so adding or closing one wakes no coordination wait.

| Kind              | Record it when                                                                    | Close it when                                     |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `pr-share`        | a PR must be shared for review, for example in a Slack thread                     | the share is posted                               |
| `review-reply`    | a review, comment, or thread needs a reply or a status from you                   | the reply is sent                                 |
| `merge-hold`      | the person said to hold a merge                                                   | the person releases the hold                      |
| `standing-rule`   | the person gives a rule for the rest of the work, such as "only use dev:trane"    | the person withdraws it, or the source work ends  |
| `person-decision` | the person decided in chat and no worker question or brief records it yet         | the decision is recorded where the work reads it  |

Pass identifiers as flags and the summary as plain text from an external file or stdin:

```sh
operator obligation add --source <id> --key share-2141 --kind pr-share --reference https://github.com/owner/repo/pull/2141 --file - --json <<'EOF'
Share #2141 in the team review thread.
EOF
```

The key has lowercase letters, digits, and single hyphens. Use a new key for each obligation in a source.
`--reference` is optional. The summary must contain 1 to 2000 characters after trimming. JSON is not accepted.
When the obligation is met, run `operator obligation close --source <id> --key <key> --json`.

`operator obligation list --source <id> --json` shows the whole ledger, closed obligations included.
An ended source keeps showing its open obligations, and it takes no new ones.

## Holds and answers

A `merge-hold` does not stop `operator pr merge`. When the PR has an owner, also send it a steering message not to merge until you release the hold, as [steering.md](steering.md) says.

A person's answer to a worker question needs no ledger entry. Record it with `--by person` as [questions.md](questions.md) says.
Use `person-decision` only for a decision that has no question to answer yet, for example a choice for an assignment that you have not dispatched. Close it once the brief, a follow-up, or an answer carries the decision.
