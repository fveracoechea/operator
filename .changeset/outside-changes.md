---
"@fveracoechea/operator": minor
---

Dispatch records a scan of the folder that holds an Operative worktree and of the controlling checkout before a production agent starts.
After the submit checks pass, `operator attempt submit` scans them again and records each difference on the submission as an outside change. It never refuses for one.
The scan leaves out every worktree that `git worktree list` names, reads no home folder, and does not walk below one level.
`operator work accept` refuses with `outside_changes_undisposed` until each outside change is disposed.
The new `operator work dispose` command records `explained`, with a reason and the evidence, or `removed`, which passes only when a new scan no longer finds the change. It never deletes a file.
A change in `.git/hooks/` or `.git/config` is kept only under an `outside-change-keep` approval of the user, and `operator crew next` offers `dispose_outside_changes` with the `approval_required` blocker for it.
`operator review show` lists each outside change.
The crew state moves to version 5.
