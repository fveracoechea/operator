---
"@fveracoechea/operator": major
---

End assignments whose worker resources are gone, and add `operator abandon` to end one assignment without deleting work or closing its PR.
A worktree assignment ends when its worker and worktree are both gone; a pane assignment ends when its pane is gone.
Resource disappearance does not prove successful completion.
Cleanup no longer treats ignored output as unlanded work, except changed environment files.
Preserve valuable ignored output before completion removes its worktree; ignored output no longer blocks that removal.
State migrations no longer block on assignment state alone, but retain live-process and lease guards.
