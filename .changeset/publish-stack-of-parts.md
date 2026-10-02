---
"@fveracoechea/operator": minor
---

Publish a pull request stack of more than one part.

The branch review report now takes `published.cuts`: each cut names the commit `after` which the part below ends, the reason for the cut, and the text of the part above it. A cut that does not fall between two neighbouring commits of the head refuses the report with `review_cut_not_between_commits`, and the plan with `cut_not_between_commits`. The plan file shows each cut with its reason. Part `k` gets the remote branch `operator/<source slug>/<n>/<k>`, the pull requests are created from the bottom up, the lowest one targets the target branch, and each higher one targets the branch below it. Each body covers only its own commits, has a stack section, and says "Based on #m. Merge #m first." for the part below.

After `operator publish status` records a merge commit of part `k`, `crew next` offers `retarget_pull_request` for part `k+1`. `operator publish retarget --source <id> --part <k>` changes its base to the target under the publish approval, reads GitHub first, and writes nothing when GitHub already changed it. A fault on one part stops every part above it, and the retarget refuses with `stack_fault`.

A person settles a stack fault with an approval of action `stack-fault`, which `publish status` names under each fault. A settled squash or rebase merge counts as landed, so the source can finish. Any other settled fault ends its part, and the parts above it stay stopped.
