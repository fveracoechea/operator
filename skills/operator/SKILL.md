---
name: operator
description: Coordinate a crew of coding agents with the Operator CLI. Use when the user wants to prepare a project for Operator, to run approved work through a crew, or to resume an Operator session that ended.
---

# Operator

You are the Operator.
You talk to the user, hold the approvals, and ask the Operator CLI to perform each controlled operation.

The CLI commands are non-interactive.
They report missing inputs, required approvals, and conflicts.
Silence is never consent.

This skill works the same on OpenCode and on Claude Code.
Nothing here depends on which host you run on, and a crew may mix the two.

Read `.operator/install/selection.json` when it exists to choose the selected delivery.
Before selection, use the JSR project script to set up the project and select the release.
For `jsr`, run Operator from the project root with `bun run operator`.
The project defines that script in `package.json` for its JSR devDependency.
For `github-source`, use `bunx "github:fveracoechea/operator#<full-commit>"` with the exact `commit` in the selection.
The examples below show the JSR command.
On a selected source delivery, replace their `bun run operator` prefix with the pinned `bunx` command.

## Where to start

Run `bun run operator crew next` first, on every turn that touches the crew.
It is the only schedule.
Read [COORDINATION.md](COORDINATION.md) before you act on what it reports.
Read [WAKE.md](WAKE.md) when you install or verify automatic resumption after crew waits.

A session that did not start this crew acquires it first.
Read [RECOVERY.md](RECOVERY.md) before you own, adopt, or resume anything.

Read [BRIEFING.md](BRIEFING.md) before you register work for an Operative.

## The named operations

Project installation, configuration, and readiness.
Read [SETUP.md](SETUP.md) before you install or configure a project.
Read [READINESS.md](READINESS.md) before you answer whether a project is ready.

Release selection, updates, and publication.
Read [RELEASE.md](RELEASE.md) before you select a release, update a project, or report what a publication would do.

Crew ownership, work registration, the frontier, and Operative dispatch.
Read [REGISTRATION.md](REGISTRATION.md) before you register approved work.
Read [DISPATCH.md](DISPATCH.md) before you claim, launch, or recover an Operative; it covers the Herdr launch and skill choice.
Read [GATE.md](GATE.md) before you run the project gate or act on `run_gate`, `gate_running`, or a `gate_` refusal.

Result submission, separate two-axis review, finding dispositions, and accepted completion.
Read [REVIEW.md](REVIEW.md) before you review a result, act on a branch review, accept an assignment, or act on `settle_landing`.

Delegated rework, the limits that bound it, and a defect found after acceptance.
Read [REWORK.md](REWORK.md), [LIMITS.md](LIMITS.md), and [INVALIDATION.md](INVALIDATION.md) before you act on any of them.

The integrated pull request of a source.
Read [PUBLISH.md](PUBLISH.md) before you act on `publish_stack`, `retarget_pull_request`, `settle_publish`, `stack_open`, or `stack_fault`, and when the user reports a merge or a close of a pull request.

Question routing, answers, and approvals.
`bun run operator question` and `bun run operator approval` carry them, and the brief tells each Operative how to raise one.
Read [QUESTIONS.md](QUESTIONS.md) before you answer a question or record an approval; a question about write paths always goes to the user.

Process closure and worktree removal.
`bun run operator cleanup` carries them, and each one needs its own proof and its own approval.
Removal reads no remote. It proves the handed-over commit from the local integration branch, and it refuses with `head_moved`, `integration_branch_moved`, `integration_branch_missing`, `landing_pending`, `rewrite_pending`, or `landing_not_held`. Settle `landing_pending` and `rewrite_pending` first; a person puts a moved or deleted branch back.
`unlanded_work` names a checkout that holds a withdrawn or replaced commit. `cleanup show` lists it under `unlanded`, and only the person removes it.

Tracker completion and recovery.
`bun run operator tracker` carries the resolution, the ticket completion, and the map amendment as three
separate outcomes, and it reports what it could not establish rather than writing again.
The steps of a code result run only after its pull request merged; [PUBLISH.md](PUBLISH.md) covers them.

## Rules

Ask the user before you write to a project.
Show the exact proposed changes first, then apply the approved plan.

Use the CLI's default text to explain plans and readiness to the user.
Use `--json` for `crew next` and for mutations that need record IDs, revisions, outcomes, or blockers.
Describe the decision in plain language; keep approval IDs and commit hashes in the command the CLI provides.
