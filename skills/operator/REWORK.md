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
- `integration`: it answers a result that no longer lands as it was reviewed.
  `crew next` offers it as `delegate_rework` with no blocker after a conflict or a changed patch at the landing, or after a failed or flaky gate run on the planned commit.
  The CLI plans the landing again, so the input names no revision.
  The cycle combines the submitted commit and the recorded tip, and it carries the failed gate run as a fixed artifact when there is one.
  `lands_cleanly` means the commit lands cleanly and no failed or flaky run is recorded at its planned commit, so no cycle opens.
  `landing_tip_changed` means that the recorded tip moved while the CLI planned the landing. Delegate the cycle again, and the CLI plans it on the new tip.
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
Claim it and dispatch it.
A `findings` or `diagnostic` cycle starts from the commit the submission recorded.
An `integration` cycle starts from the commit its result lands on, so dispatch it with no `--commit`: the recorded tip of the integration branch, or, for a correction of a landed commit, the parent of the commit it replaces.
`dispatch_base_not_tip` means you named another commit.
A fresh attempt is a fresh Operative, so the reviewer that found the problem never repairs it.

One cycle produces one combined revision, which registers its own review assignment.
That reviewer reads every earlier round and its dispositions, and reports a finding that came back.
After an `integration` cycle, that reviewer also receives the reviewed patch and the interdiff from it to the new patch.
Nothing between the two revisions is acceptable, so do not accept the earlier submission.
After the combined revision is accepted, the checkout of each earlier attempt holds a replaced commit.
`crew next` offers no removal of it, and `cleanup remove` refuses it as `unlanded_work`. Only the person removes it.

## A correction of a landed commit is rewritten in place

The acceptance of a correction of a landed commit rebuilds the integration branch in the same order.
The correction takes the place of the landed commit, on its parent, and each later commit lands again with a new identity and an equal patch.
`crew next` offers `run_gate` once for each commit of the rebuilt range, in order, and the plan is made again after each run.
When every commit passed, `crew next` offers `accept_assignment`, and `work accept` moves the branch once and reports the rewrite under `landing.rewrite`.

A later commit is taken out, and its cause is named, when its patch changes (`patch-changed`), it conflicts (`conflict`), it fails the gate at its new place (`gate`), or a commit it depends on is taken out (`dependency`).
A result taken out is paused as a consumer of the corrected result: it returns to awaiting review, and `crew next` offers its landing again as an ordinary landing on the new tip.
An equal patch then lands with no new review, and a changed patch is an `integration` cycle.
A correction that conflicts, changes its patch, or fails the gate at its own place lands nothing, and `crew next` offers an `integration` cycle from the parent of the commit it replaces.

`rewrite_published_range` means the commit is inside a published pull request, which is never rewritten in place.
While that pull request is open, `crew next` offers `recall_stack` first: read "Recall" in [PUBLISH.md](PUBLISH.md). After the recall, repeat the acceptance.
A commit whose pull request merged refuses for ever: tell the person and name that pull request, and the defect becomes a new issue.
`rewrite_tracker_recorded` means a tracker step already ran for a result that the rewrite would take out, so its ticket says the work is done; bring it to the person.
A rewrite whose move stopped is offered as `settle_landing`; repeat `work accept`.
Until then, `cleanup remove` refuses each checkout of the source with `rewrite_pending`.
After the rewrite, the checkout of the corrected attempt holds a replaced commit, so only the person removes it.

A cycle is bounded. Read [LIMITS.md](LIMITS.md) when one is refused with `limit_reached`.
