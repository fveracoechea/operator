# Delegating a correction

Read this when a review finding is yours to correct, when a result must be combined with another revision, or when a recorded check needs a diagnostic rerun.

Never edit the result yourself, and never ask the reviewer to repair what it found.
`rework_pending` at acceptance means the correction has not landed yet.

```
bun run operator work rework --request <id> --owner-token <token> --assignment <id> --revision <n> --input <path> --json
```

The request names one reason:

- `findings`: it answers the accepted corrections of the review you name.
  Every finding of that review carries a disposition first.
- `integration`: it names the revisions it combines with the submitted result.
  Name a review only when this cycle answers that review as well.
  A review that already reported is answered either way, so its findings are never lost.
- `diagnostic`: it names the recorded checks a test infrastructure failure is suspected behind.
  At least one of them must not have passed.

The input takes no instruction, and an input that names one refuses with `invalid_rework_input`.
Each reason renders one fixed sentence that the release owns.
The brief also carries what the crew state recorded about the earlier rounds of the assignment, so you copy none of it into the input.
State each conflict the Operative must settle.
You record no resolution of your own, because that decision is the work you are delegating.
A conflict names only work this cycle carries.
`conflict_not_corrected` means you named a finding that no correction in this cycle answers.

The cycle returns the assignment to the frontier.
`bun run operator crew next` offers it again.
Claim it and dispatch it from the commit the submission recorded.
A fresh attempt is a fresh Operative, so the reviewer that found the problem never repairs it.

One cycle produces one combined revision, which registers its own review assignment.
That reviewer reads every earlier round and its dispositions, and reports a finding that came back.
Nothing between the two revisions is acceptable, so do not accept the earlier submission.

A cycle is bounded. Read [LIMITS.md](LIMITS.md) when one is refused with `limit_reached`.
