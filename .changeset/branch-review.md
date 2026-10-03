---
"@fveracoechea/operator": minor
---

Register one branch review of each integration branch when the branch becomes final.

The acceptance or the withdrawal that leaves every code assignment of a source accepted or withdrawn now registers a branch review in the same change, and `work accept` and `work register` report it as `branchReview`. A source with one code commit registers none. The branch reviewer starts at the head of a recorded branch snapshot, reads the fixed text of the source, which `work register` now stores, the spec copy of every item, and every earlier review of the source, and names the target commits of each finding. Its report refuses with `snapshot_drift`, `review_finding_untargeted`, or `review_finding_target_unknown`. A corrected branch finding names one `target` assignment and invalidates it in the same change, and `review dispose` refuses with `correction_target_required`, `correction_target_unknown`, or `correction_target_not_expected`. A fourth branch review of one source waits on a direction request of the scope `limit:branch_reviews`. The crew state moves to version 14.
