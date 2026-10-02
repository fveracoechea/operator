---
"@fveracoechea/operator": minor
---

An integration cycle now answers a result that no longer lands as it was reviewed. `operator work rework` with the reason `integration` plans the landing again and names no revision in its input: it combines the submitted commit with the recorded tip, carries a failed gate run as a fixed artifact, and refuses with `lands_cleanly` when the commit lands cleanly and no failed or flaky run exists. `crew next` offers `delegate_rework` with no blocker after a conflict, a changed patch, or a failed or flaky candidate. The cycle dispatch starts from the recorded tip, and the review of the new commit receives the reviewed patch and the interdiff.
