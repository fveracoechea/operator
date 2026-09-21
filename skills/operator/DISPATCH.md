# Dispatching an Operative

Read this before you launch, recover, or replace an Operative.

## Order of work

1. `operator crew own --request <id> --owner-label <label> --json` gives you the owner token every mutation needs.
2. `operator work register --request <id> --owner-token <token> --input <path> --json` records the approved work.
3. `operator work frontier --json` says what may start now and why the rest waits.
4. `operator work claim --request <id> --owner-token <token> --assignment <id> --revision <n> --json` gives you one attempt.
5. `operator attempt dispatch --request <id> --owner-token <token> --attempt <id> --commit <sha> --json` launches it.
6. The Operative hands over its result with `operator attempt submit`. Read [REVIEW.md](REVIEW.md) from there.

Generate a new request identity for each mutation.
Repeat the same identity only to recover the result of a call you did not see finish.

## The commit is yours to choose

A dispatch starts from an explicit commit.
Name the commit the assignment must build on.
A worktree never picks up uncommitted work from another checkout, so ask the user to commit or to choose a different base when needed inputs are not committed.

## Pending is the normal answer

Herdr acknowledges that it submitted the brief, not that the Operative read it.
A dispatch reports `pending` with `acknowledgement_pending` until the Operative runs `operator attempt acknowledge` from its own worktree.
Wait for that acknowledgement before you treat the assignment as started.

Use a bounded Herdr wait or a periodic check while you wait.
Do not start a second writer.

## Uncertain is not failure

Exit 5 means a call did not answer.
The effect may have landed.

Run `operator attempt reconcile --request <id> --owner-token <token> --attempt <id> --json`.
It reads what Herdr and the checkout actually hold and settles each unfinished effect.

A delivery that stays unproven while the writer is live is yours to bring to the user.
Never resend a brief to a live Operative.
A timeout does not prove non-delivery.

## Drift blocks a recovery

A launch records the crew host, model, release, lock data, and skills it used.
A recovery restores that record.

Exit 4 with `snapshot_drift` means the project changed since the launch.
Report each named field to the user.
A session override does not replace a recorded launch, and a new setting reaches new launches only.

## Replacing a writer

A replacement is a new attempt on the same assignment.

1. Settle every effect first. `reconciliation_required` means an effect is still unproven.
2. Prove the former writer stopped. `writer_live` means it is still running, so stop it and confirm its termination with the user.
3. Read the partial work. `operator attempt replace` without `--inspection` reports the uncommitted files and the commits since the base.
4. Repeat the command with `--inspection <identity>` to approve that exact reading.

The inspected checkout and branch are retained.
Never delete a checkout to make a replacement simpler.

## Direct Herdr use

Read-only inspection and bounded waits only.

Never create a worktree, start an agent, send keys, submit a prompt, close a workspace, or remove a checkout by hand.
Those effects are recorded operations, and a hand-run one leaves the crew state wrong.
