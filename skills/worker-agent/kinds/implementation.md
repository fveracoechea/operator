# Implementation

Use `tdd` and `pr` for the brief's spec and test seams; use `diagnosing-bugs` for failures.
Read a supplied promotion note, checking its claims.
For adoption, inspect existing PR threads and branch first; preserve its ownership and head branch.
Commit and push tested work to one PR against the brief's base.
With internal review on, open a draft.
Otherwise open it ready.
Run `operator pr associate`; stop once it succeeds.
The CLI hands the assignment to review, or to pr-feedback when internal review is off and the PR is ready.
Send no implementer note to review.
