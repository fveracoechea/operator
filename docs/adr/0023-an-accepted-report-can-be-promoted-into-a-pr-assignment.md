# ADR-0023: An accepted report can be promoted into a PR assignment

## Status

Accepted - 2026-11-04.
Decided in #313.
Amends ADR-0012 and ADR-0013.
Implemented in #322, and the steering message that hands over the worker in #326.

## Context

A report assignment often ends with the conclusion that the work should be built.
The SuperAgent then registered a new source with a PR assignment that depended on the accepted report, and a fresh worker started without the investigation's context or the worktree that held its prototypes.
Acceptance closed the report worker's pane, so that context was gone before the next registration.
A comparison with firstmate, another agent coordination tool, recommended against a change because a new source already gave the same result.
The person ordered promotion despite its conflict with fixed completion types and registered plans.

## Decision

The supervising SuperAgent can promote a report assignment when it accepts the report.
Promotion is one operation with two effects.
The report assignment completes as an accepted report, so its dependents unblock as before.
The same source gains one new PR assignment, with instructions and a tracker key that the SuperAgent supplies, and the accepted report as its dependency.

The PR assignment takes over the report assignment's worktree.
When the report worker still runs, the CLI keeps its pane open and refreshes its brief from the PR template.
The promotion records a steering message from the SuperAgent that tells the worker to read the new brief.
That worker becomes the PR owner with its investigation context.
When the worker has stopped, the PR assignment starts like any replacement, in the same worktree, with the accepted report among its earlier reports.
The worktree's branch takes the PR assignment's name before its first push, so names keep showing the task type.

Promotion refuses a report assignment that has no worktree, because read-only report work has nothing to reuse.
It refuses on an ended source, and it refuses a report that is not awaiting acceptance.
A report is promoted at most once.

Completion types stay fixed.
The report assignment never becomes a PR assignment, and the PR assignment is a new record with its own lifecycle.
Internal review applies to the promoted PR assignment as to any other, so a fresh reviewer takes over its draft PR.
Source reset treats a promoted PR assignment like every other incomplete assignment.

## Consequences

- A registered plan is no longer the complete list of a source's assignments, because promotion can add one PR assignment for each accepted report.
  Next actions and reset read the promoted assignments with the registered ones.
- The PR owner starts with the investigation's reasoning, including its mistakes and biases.
  Internal review and the person's merge approval remain the independent checks.
- A promoted worktree can hold prototype changes that the PR must not keep, so the owner cleans its branch before the first push.
- The worktree cleanup rule of an accepted report does not apply to a promoted report, because its worktree now belongs to a running PR assignment.

## Alternatives considered

- A new source with a dependency on the accepted report stays available, and it was not made the only path because it loses the worker's context and worktree.
- Changing the report assignment's completion type in place was rejected because dependents and acceptance history rely on a fixed type, and a report dependency would silently become a PR dependency.
- A general operation that adds or edits assignments of an open source was rejected because it would make the plan a second schedule that the SuperAgent maintains outside registration.
- Promotion after acceptance, as a separate step, was rejected because acceptance closes the worker's pane, which loses the context that promotion exists to keep.

Related: ADR-0010, the promoted assignment follows the PR lifecycle; ADR-0011, worktree names and brief refresh; ADR-0012, sources gain promoted assignments; ADR-0013, acceptance can promote; ADR-0020, internal review applies; ADR-0022, the steering message that hands over the worker.
