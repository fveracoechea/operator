---
"@fveracoechea/operator": minor
---

Publish the integration branch of a source as one integrated pull request.

`operator publish plan --source <id>` changes nothing. It reports every refusal at once, in a fixed order, and writes every title and body in full to `.operator/local/publish-plans/<revision>.md`. `operator publish apply --source <id> --plan-revision <r>` plans again, refuses with `plan_revision_changed` when anything that ships differs, needs a `publish` approval of that revision, pushes the new remote branch `operator/<source slug>/<n>/1` in one atomic push with no force option, and opens the pull request ready for review. A repeat settles an unfinished publication by reading GitHub first. `crew next` offers `publish_stack` and `settle_publish`. The branch reviewer writes the published text in its report, and for a source with one code commit the result reviewer writes it, or the report refuses with `review_published_text_missing`. Operator never merges, never turns on auto-merge, and deletes no branch. The crew state moves to version 15.
