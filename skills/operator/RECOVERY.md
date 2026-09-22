# Resuming a crew that another session started

Read this when you are a fresh Operator, or when the user says a session ended.

A crew survives the process that started it.
Assignments, attempts, questions, answers, approvals, reviews, tracker steps, and cleanups are all recorded, so recovery reads them rather than guessing.

## Take the crew before you change anything

```sh
operator crew next --claude --json
```

Read the ownership it reports.
`data.ownership` names the Operator that holds the crew now.

If that Operator is gone, take the crew and name the ownership revision you read.

```sh
operator crew own --request <id> --owner-label <label> --takeover --ownership-revision <n> --json
```

A takeover replaces the active token.
The replaced token can no longer change crew state, so a stale session cannot write behind you.
`ownership_revision_stale` means the ownership moved while you read it, so read it again.

A takeover also moves the revision that cleanup approvals are granted against.
An approval that was granted to the former session therefore covers nothing here.

## Settle the effects before you adopt

A takeover blocks every attempt the former Operator claimed.
`operator crew next` reports each one, and it reports a reconciliation before an adoption when an effect is still unproven.

```sh
operator attempt reconcile --request <id> --owner-token <token> --attempt <id> --json
```

Reconciliation reads what Herdr and the checkout actually hold, and settles each unfinished effect.
It sends nothing.
An effect that stays uncertain is yours to bring to the user, never to repeat.

Tracker effects are settled separately, because a tracker step is not an attempt.

```sh
operator tracker show --assignment <id> --json
operator tracker recover --request <id> --owner-token <token> --operation <id> --json
```

`operator tracker recover` reads the tracker and settles one recorded step from what it shows.
An unsuccessful read leaves the step where it was, because it does not prove that a write did not apply.
A step left uncertain accepts another write only under a person's approval.

## Adopt the attempts that are still valid

```sh
operator attempt adopt --request <id> --owner-token <token> --attempt <id> --json
```

Adoption states that this session read what the attempt holds.
It changes nothing about the work, the checkout, the brief, or the questions.

It runs only when both are true:

- every effect of that attempt is settled,
- the Operative is still running.

`reconciliation_required` means an effect is still unproven, so reconcile first.
`adoption_writer_stopped` means Herdr holds no agent under the recorded name.
That attempt is replaced, not adopted, so read [DISPATCH.md](DISPATCH.md) and inspect its partial work.
`writer_unknown` means Herdr could not answer, which proves nothing either way, so bring it to the user.

An attempt that already ended needs no adoption.
A submitted result, a reported review, and an accepted assignment are records, not writers.

## Resume everything else from the next actions

After the adoptions, `operator crew next` reports the rest of the recovery in its order:

- `answer_question` and `deliver_answer` for a question the former session left open,
- `dispose_findings` and `accept_assignment` for a review that already reported,
- `record_tracker` and `recover_tracker` for the tracker steps of accepted work,
- `close_process` and `remove_worktree` for the resources an Operative left behind,
- `direct_limit` for a limit that reached the user and was never answered.

A retention hold appears in `data.waits`, not in the actions.
It outlives the session that placed it, and only a person releases it.

## What recovery never does

Never resend a brief to a live Operative.
Never start a second writer on one assignment.
Never delete a checkout to make a recovery simpler.
Never treat a timeout as proof that an effect did not happen.
