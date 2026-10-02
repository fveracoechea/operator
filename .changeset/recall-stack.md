---
"@fveracoechea/operator": minor
---

Recall an open published range before a change, and publish it again.

`work invalidate` of a commit in an open pull request, or a withdrawal of an item whose commit is in one, makes `crew next` offer `recall_stack` with `approval_required`. `operator publish recall --source <id>` plans the recall and changes nothing. With an approval of action `stack-recall` bound to its plan revision, `operator publish recall --source <id> --plan-revision <revision>` turns each open pull request from the affected part up into a draft and adds one comment, rendered from the defect or the withdrawal record. The parts below stay open. Until the recall is done, the rewrite and `work take-out` refuse with `rewrite_published_range`.

The next stack publication has a new number and new remote names, starts above the parts that stay open after they merge (`stack_part_open` until then), and closes each recalled pull request with a pointer to its replacement, under its own publish approval. When every code item above the recalled point is withdrawn, the recall also closes the pull requests.

A merge before the recall is the stack fault `merged_before_recall`, and `work invalidate` of a merged commit refuses with `invalidation_merged`. When the person settles that fault, the open invalidation closes with no correction, its paused dependents return to their earlier state, and the merged part counts as landed. A close of a replaced pull request whose head is not the published commit writes nothing to it. After a settled fault that ends a part, `crew next` offers `publish_stack` for a new publication. A conflict that a retarget, a recall, or a close finds names a `stack-fault` settlement, and the person's approval of it ends the conflict.
