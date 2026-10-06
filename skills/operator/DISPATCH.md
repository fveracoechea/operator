# Dispatching an Operative

Read this before you launch, recover, or replace an Operative.

## Order of work

1. `bun run operator crew next --claude --json` reports readiness, ownership, and the next action.
   Read [COORDINATION.md](COORDINATION.md) for that loop.
2. If no session owns the crew, `bun run operator crew own --request <id> --owner-label <label> --json` gives you the owner token.
   Read [RECOVERY.md](RECOVERY.md) before you take over a crew another session owned.
3. `bun run operator work register --plan --input <path> --json` previews the approved work, and `bun run operator work register --request <id> --owner-token <token> --input <path> --plan-revision <revision> --json` records that plan.
   Read [REGISTRATION.md](REGISTRATION.md) for what that request carries.
4. When `crew next` offers a claim, `bun run operator work claim --request <id> --owner-token <token> --assignment <id> --revision <n> --json` gives you one attempt.
5. When `crew next` offers `run_gate` instead, the first code dispatch of the source waits for its integration base to pass the project gate.
   Read [GATE.md](GATE.md) for that run.
6. When `crew next` offers dispatch, `bun run operator attempt dispatch --request <id> --owner-token <token> --attempt <id> [--commit <sha>] --json` launches it.
   The next section says when it takes `--commit`.
7. The Operative hands over its result with `bun run operator attempt submit`.
   Read [REVIEW.md](REVIEW.md) from there.

Dispatch creates the Herdr worktree and sends the fixed prompt.
Run dispatch from the Operator's Herdr pane.
It groups the new worktree workspace with the Operator's current workspace and keeps that parent on retries.
Dispatch refuses a new launch when it cannot identify the current workspace.
That prompt tells a production or rework Operative to load `operative` from its worktree.
A review assignment receives `code-review` instead.

Generate a new request identity for each mutation.
Repeat the same identity only to recover the result of a call you did not see finish.

## Where each dispatch starts

The CLI fixes where a dispatch starts. Name a commit only where this list says so.

- The first code dispatch of a source names its integration base with `--commit`.
  It refuses until that commit passed the project gate, as [GATE.md](GATE.md) describes.
  Then it creates the integration branch `operator/integration/<source slug>` at that commit, and it records the branch name, the base, and the project gate on the source.
- Every later production dispatch of the source starts from the recorded tip of that branch. Run it with no `--commit`.
  A `--commit` that differs refuses with `dispatch_base_not_tip`, and `crew next` names the recorded tip.
- A findings or diagnostic rework attempt starts from the submitted commit it reworks. Name that commit with `--commit`.
- A correction of a landed commit starts on the parent of that commit, with no `--commit`, as [INVALIDATION.md](INVALIDATION.md) describes.
- A review starts from the submitted commit.

For a review and for a findings or diagnostic rework, the `dispatch_attempt` action of `crew next` names the submitted commit in its `command`, so you never read it from Git.

A branch that holds any other commit than its recorded tip stops every production dispatch of its source with `integration_branch_moved`.
The refusal names the recorded tip, the tip it found, and each worktree that has the branch checked out.
You never reset the branch and never dispatch from the tip it found. Report both tips to the user, who puts the branch back.
`integration_branch_exists` means a branch with that name already holds another commit before the first code dispatch. Report it to the user, because Operator never takes over a branch it did not create.
`integration_branch_held` means another source records that branch name. Report it to the user. Nothing was launched.
Nothing pushes the integration branch.

A worktree never picks up uncommitted work from another checkout, so ask the user to commit or to choose a different base when needed inputs are not committed.

## The project gate comes from the integration base

A producer brief states the project gate that `operator-gate.json` declares at the integration base, with each command beside the submit command.
The first code dispatch fixes that gate on the source, so a later change to the file counts only for a later source.
Dispatch and replace of a production attempt refuse with `project_gate_missing`, `project_gate_invalid`, or `project_gate_unread` when that commit holds no valid gate, and nothing launches.
The person commits the file, because setup does not write it and you commit nothing.
Then dispatch from a commit that holds it.
A review attempt reads no gate at dispatch, because its registered commands already permit the gate commands.

## Skill copies come from the release

Dispatch copies the skills of the selected release into each worktree, and it fails at `input_preparation` with `skill_copy_conflict` when the launch commit holds a different copy.
A tracked copy that crew work changed after the integration base is not a conflict: the launch keeps that copy and records it, so a review reads the skill text the result wrote.

## Pending is the normal answer

Herdr acknowledges that it submitted the brief, not that the Operative read it.
A dispatch reports `pending` with `acknowledgement_pending` until the Operative runs `bun run operator attempt acknowledge` from its own worktree.
Treat the assignment as started only after that acknowledgement.
When `crew next` reports a wait for it, report the wait and yield as [COORDINATION.md](COORDINATION.md) describes.
Do not start a second writer.

## An Operative never asks the person

Dispatch starts a Claude Code Operative with `--permission-mode dontAsk` and an allow list built from its brief.
The allow list is in `.operator/local/claude-settings.json` in the Operative worktree, and the launch passes it with `--settings`.
A producer may also run `git status`, `git add`, and `git commit`, so it can make the one commit of its result.
A reviewer may not.
Its host refuses every other tool and never shows a permission prompt.
A refusal reaches you as a question, as [COORDINATION.md](COORDINATION.md) describes.

## Uncertain is not failure

Exit 5 means a call did not answer.
The effect may have landed.

Run `bun run operator attempt reconcile --request <id> --owner-token <token> --attempt <id> --json`.
It reads what Herdr and the checkout actually hold and settles each unfinished effect.

A delivery that stays unproven while the writer is live is yours to bring to the user.
Never resend a brief to a live Operative.
A timeout does not prove non-delivery.

## Drift blocks a recovery

A launch records the crew host, model, reasoning effort, release, lock data, and skills it used.
A recovery restores that record.

Exit 4 with `snapshot_drift` means the project changed since the launch.
Report each named field to the user.
A session override does not replace a recorded launch, and a new setting reaches new launches only.

## Replacing a writer

A replacement is a new attempt on the same assignment.

1. Settle every effect first. `reconciliation_required` means an effect is still unproven.
2. Prove the former writer stopped. `writer_live` means it is still running, so stop it and confirm its termination with the user.
3. Read the partial work. `bun run operator attempt replace` without `--inspection` reports the uncommitted files and the commits since the base.
4. Repeat the command with `--inspection <identity>` to approve that exact reading.

The inspected checkout and branch are retained.
Never delete a checkout to make a replacement simpler.

## One crew, two hosts

A dispatch may name its own crew host and model with `--crew-host` and `--crew-model`.
The launch records that selection, so two Operatives of one crew can run on different hosts.

Everything else stays the same.
The brief, the protocol, and every command are identical on OpenCode and on Claude Code.
A recovery restores the recorded host, so a session override reaches new launches only.

## Direct Herdr use

Read-only inspection and bounded waits only.

Never create a worktree, start an agent, send keys, submit a prompt, close a workspace, or remove a checkout by hand.
Those effects are recorded operations, and a hand-run one leaves the crew state wrong.
