# ADR-0031: Workers receive device-state briefs and Herdr resources

## Status

Accepted - 2026-10-24.
Decided in #210, amended by #228 and #233.
Supersedes ADR-0005.
Planned, not yet implemented.

## Context

Dispatch copied control references, release data, host files, and briefs into each worker checkout.
Those files repeated device facts and tied lookup to markers that the worker could edit.
Hand-chosen worktree paths could also put project work under state that pruning would delete.

## Decision

The CLI dispatches through Herdr with a brief from the running release's template and a resolved start profile.
Briefs and review drafts live in device state, and the launch supplies an absolute brief reference.
A new start refreshes the assignment's brief from the running template rather than creating an immutable file for every start.
The brief does not identify the runtime agent.
Prior reports and follow-up instructions remain available when a replacement starts.

Operator keeps no coordination marker, release record, copied lock data, owned skill, or host configuration in a worktree.
Worker PR operations locate their assignment only through the real Git top level of its recorded active worktree.
They do not accept an assignment selector that could redirect one worker to another's PR.

Herdr chooses each worktree path and returns it to Operator.
Work that changes project files uses an isolated Herdr worktree.
Read-only report work normally uses a separate pane in the project's workspace and declares whether isolation is needed.
Reviewer worktrees stay at the PR head and write drafts outside the checkout on branches that Operator never pushes.
Reviewer cleanup removes the local reviewer branch and worktree.
Names show the task type, tracker key, and a short task description instead of generated issue-title text.
A collision gets a distinct recorded name, never adoption or deletion of an unrecorded branch or worktree.

One stable Herdr worktree-creation hook prepares every new worktree of a registered project, including those not dispatched by Operator.
It copies ignored local environment files from the controlling checkout without overwriting existing files, then installs project dependencies from the lockfile.
These project inputs are distinct from the coordination files that remain in device state.

## Consequences

- Lookup depends on the recorded real checkout path, so an unrelated clone or pane cannot operate on another assignment's PR.
- A replacement receives the current brief template while earlier reports preserve its task history.
- Environment-file preparation carries local project configuration into isolated worktrees and must preserve existing content.
- Herdr resource ownership requires integration checks for names, collisions, workspace selection, and returned paths.

## Alternatives considered

- Worktree control markers and copied release or lock files were rejected because device records and Git-top-level lookup already identify the assignment.
- Worktrees under Operator state were rejected because source pruning must not delete a checkout.
- A new brief for every start and a brief that never refreshes were rejected because they either duplicate history or keep replacements on an obsolete template.
- Reusing colliding names was rejected because an unrecorded resource may contain someone else's work.
- Mandatory worktrees for read-only reports were rejected because those tasks need a separate process, not necessarily a separate checkout.

Related: ADR-0005, historical staged dispatch protocol; ADR-0025, controlling-checkout identity; ADR-0024, device path ownership; ADR-0033, report resources and replacement; ADR-0034, launch selection; ADR-0035, reviewer drafts and stable plugin hooks.
