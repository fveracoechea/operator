# Managed stacks

Use the child's owned worktree. Commit and push all child work first.

1. Run `operator pr stack plan --json`. Add `--parent <assignment>` for an implemented sibling from the same source.
2. Inspect the pinned heads, old cut, and target base. Run `operator pr stack apply --plan <id> --json`.
3. After completion, run `operator pr stack review --plan <id> --json`. Stop after the fresh-reader handoff starts.

Several independent prerequisites use a per-child dependency-only base. Target its recorded branch when opening a new child PR.
Keep prerequisite owners' refs and worktrees unchanged. A parent merge is not a workaround for a stack refresh blocker.

An interrupted operation retains its exact inputs and failures. Read `operator source show` or `operator next` before recovery.
Repeat `apply` with the same ID to resume. A replacement owner can recover only in the same recorded worktree and branch.
When pinned prerequisites move, cancel only a clean, pushed, confirmed original or installed child before planning again.
`operator pr stack cancel --plan <id>` preserves child work and installed dependency provenance.
An unconfirmed PR-base write remains blocked until its external outcome is established; do not repeat it blindly.
For an attribution refusal, preserve the work and ask the SuperAgent. `--cut` cannot authorize an arbitrary ancestor.

Changed ancestry invalidates previous readiness and review evidence. The PR stays a draft until a fresh reviewer qualifies the new diff.
After every prerequisite merges, the managed relay preserves only the child's delta and requires fresh review of the default-branch diff.
Merge eligibility never overrides an explicit merge hold.
