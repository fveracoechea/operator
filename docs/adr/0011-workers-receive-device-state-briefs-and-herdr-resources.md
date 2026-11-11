# ADR-0011: Workers receive device-state briefs and Herdr resources

## Status

Accepted - 2026-10-24.
Decided in #210, #228, and #233.
Implemented in #247.
Amended 2026-11-11: a PR assignment can adopt an open PR and use its branch, although Operator did not create it (ADR-0024).

## Context

Workers needed task instructions without adding coordination files to each project checkout.
Editable worktree markers would repeat device facts and let workers change their own lookup inputs.
Hand-chosen worktree paths could also put project work under state that pruning would delete.

## Decision

The CLI dispatches through Herdr with a brief from the running release's template and a resolved start profile.
Briefs and review drafts live in device state, and the launch supplies an absolute brief reference.
A new start refreshes the assignment's brief from the running template rather than creating an immutable file for every start.
The brief does not identify the runtime agent.
Prior reports and follow-up instructions remain available when a replacement starts.

Coordination inputs and launch provenance stay in device state rather than worker checkouts.
Worker PR operations locate their assignment only through the real Git top level of its recorded active worktree.
They do not accept an assignment selector that could redirect one worker to another's PR.

Herdr chooses each worktree path and returns it to Operator.
Work that changes project files uses an isolated Herdr worktree.
Read-only report work normally uses a separate pane in the project's workspace and declares whether isolation is needed.
Reviewer worktrees stay at the PR head and write drafts outside the checkout on branches that Operator never pushes.
Reviewer cleanup removes the local reviewer branch and worktree.
Names show the task type, tracker key, and a short task description instead of generated issue-title text.
A collision gets a distinct recorded name, never adoption or deletion of an unrecorded branch or worktree, except the branch of an open PR that the plan adopts.

One stable Herdr worktree-creation hook prepares every new worktree of a registered project, including those not dispatched by Operator.
It copies ignored local environment files from the controlling checkout without overwriting existing files, then installs project dependencies from the lockfile.
An install lifecycle script, such as Husky's `prepare`, can write ignored files outside the dependency folders.
Preparation records each ignored file that appeared during the install, with its content hash, in the worktree's preparation record.
Cleanup disposes such a file only while its content equals the record. A changed or unrecorded ignored file still blocks.
Preparation does not run the install with `HUSKY=0`, because a project's shared `core.hooksPath` can point at Husky's output, and it keeps no allowlist of known hook folders, because any lifecycle script can write ignored files.
The cost: a file that someone else writes while the install runs is recorded as install output.
A worktree prepared before this record existed has none, so its install output blocks cleanup until the person instructs a forced removal.
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

Related: ADR-0005, controlling-checkout identity; ADR-0004, device path ownership; ADR-0013, report resources and replacement; ADR-0014, launch selection; ADR-0015, reviewer drafts and stable plugin hooks.
