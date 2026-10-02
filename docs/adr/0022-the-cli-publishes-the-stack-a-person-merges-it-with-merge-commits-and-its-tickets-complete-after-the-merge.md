# The CLI publishes the stack, a person merges it with merge commits, and its tickets complete after the merge

Operator could land, gate, and review an integration branch, but nothing pushed it, opened its pull requests, or wrote their bodies.
In a flow run by hand, the main agent pushed a new branch, opened the pull request, wrote one line for each commit with its issue, and wrote a "Done in" link on each issue last, because a rebuilt history changes every commit.
The tracker resolution of a code result was written at acceptance, before any commit had a final place, and a branch finding could then reopen a ticket that was already closed.
A squash merge of the lowest pull request of a stack also rewrites what the higher ones are based on.

The CLI publishes.
`operator publish plan` changes nothing: it reads the recorded branch snapshot, the gate runs, and the reviews with their published text, and it reports a summary with a plan revision and writes every pull request in full to a local file.
`operator publish apply` plans again, refuses when the revision differs, and then writes, behind one approval of that revision.
The plan refuses unless the branch review of ADR 0017 reported on the exact head, the gate runs of ADR 0021 pass at the base and at every commit, and no invalidation, withdrawal, or direction request is open.
The revision covers everything that ships: the head, the cut points with their reasons, the titles, every body, the remote, the remote branch names, the target branch, and the integration base.
It does not cover the tip of the target branch, because a new commit on the target does not change what ships, and the apply still refuses when the integration base is not an ancestor of that tip.
The whole stack publishes at once; the cut points divide the review, not the timing.
A source whose branch holds no commit above its base has nothing to publish, and it is finished when its other work is.

The target branch is the default branch of the source repository, read at the plan.
Closing keywords work only in a pull request to the default branch, and a code ticket is completed when its commit reaches the target (ADR 0016), so a second target would need a second close path.

Each stack publication has its own number, and each of its pull requests has a new remote branch of its own.
One atomic push creates every remote branch with no force option, and the plan refuses when a name already exists.
So a push never replaces a remote ref, and the rule of ADR 0020 that nothing is pushed with force has no exception.
The pull requests are created from the bottom up, ready for review: the lowest one targets the target branch, and each higher one targets the remote branch below it.
Each write is a staged effect under ADR 0005.
Recovery reads GitHub: the remote names at their planned commits, and the pull request whose head is a new remote name, which the server allows only once.

Each body is rendered by the CLI from the records, with a closed set of sections that a reviewer writes, and the approval covers the exact text.
The rendered sections are the commit list, with each subject linked to its commit and a closing keyword for its issue; the behavior changes of each commit with their basis (ADR 0018); the project gate commands and the runs that passed; the reviews by their identity; each rejected finding as what looks wrong and is not; each deferred finding with its follow-up as what is not in this pull request; the concerns the producers recorded; the stack position; and how to merge.
The branch reviewer writes the title, a summary, where to start reading, and the merge danger of each pull request, and each cut point with its reason, in its report, because it read the whole head and no record holds that judgment; for a source with one code commit, the result reviewer of that commit writes it.
The Operator writes no content of its own, so it only passes this published text on, and `operator publish plan` takes no input from it.
The published text goes to people and not to a brief, and the person approves it word for word, because the plan revision names every title and body.
The plan prints a summary and writes every title and body in full to a local file named by its revision, which the person reads before the approval.
A body is final at its create: it links each commit by its identity, and it names only the pull request below it, whose number is recorded by then.
A cut falls only between two neighbouring commits of the head, so the branch report and the plan refuse any other cut with the same rule.

A person merges.
Merging follows the human review on GitHub, and the person who merges is often not the user of the Operator.
The Operator and the crew never merge a pull request and never turn on auto-merge, and a merge by a teammate of the person counts as the approval of the person.
Each pull request merges with a merge commit, from the bottom up, because only a merge commit brings each commit to the target with the identity and the tree that were reviewed and gated.
The plan refuses when the repository or a rule of the target branch does not allow a merge commit, and when a rule requires signed commits, because Operator pushes the unsigned commits of ADR 0020 and signing is not decided.
A rule that the plan cannot read is shown as unverified, never as a pass, and a push that GitHub rejects lands nothing.

`operator crew next` never reads the tracker, and no event reaches the crew when a pull request merges.
So while a pull request is open, the next actions show the wait `stack_open` that names `operator publish status --source <id>`, and the Operator runs that read when the user reports a merge or a close, or asks for the state.
The read records what GitHub shows of each pull request: its state, its head, its base, its merge commit, and its merge method, which the parents of the merge commit tell.
The next actions then offer what follows, from the recorded readings only.
After a merge commit of one part, the CLI changes the base of the next part to the target branch, under the same approval, and it reads first, so a base that GitHub already changed is satisfied with no write.
GitHub reads the closing keywords of a body again once its base is the default branch: a pull request that was opened on another base, never edited, and then based on the default branch closed its issue at its merge (checked with read-only calls on a public repository for ticket #120).
The completion step still closes a ticket that its keyword did not close.

The three tracker steps of a code result run only after the recorded merge of the pull request that carries its commit into the target branch.
The resolution is a rendering with no free text: the commit on the target, the pull request, and the behavior changes with their basis, and a free body refuses.
The `publish` approval names the resolution and the completion of each item as targets, and the plan shows each resolution already rendered, with the number of its pull request as its one slot, so no tracker write after the merge happens without that approval.
When the source has a map issue, the `publish` approval also names the map amendment of each item as `github:<owner>/<repo>#<n>:map_amendment`.
The map amendment keeps the input the Operator states (decision 18), so the plan cannot render its text.
After the merge, its first `operator tracker record` renders the exact comment to a local file, writes nothing, and refuses with `map_amendment_approval_required`.
`crew next` then offers `record_tracker` with `approval_required` and names that file and the request: action `map-amendment`, the map issue as `github:<owner>/<repo>#<n>:map_amendment`, the assignment as scope, and the content identity of the rendered comment as request revision.
The write runs only when such an approval binds that exact text, and an approval of other text covers nothing.
Before any write, a person may reject the text, and the Operator states other text, which replaces the unsent intent.
The completion step closes the ticket as completed, or observes the close that the closing keyword made, as ADR 0009 allows.
A planning resolution is still rendered at acceptance (ADR 0019).

A merge that is not a merge commit, a merge into a base that is not the target, a commit that no review read on a pushed branch, and a close with no merge are each a stack fault that waits on a person with the blocker `stack_fault`.
Operator adopts nothing from a stack fault, as it adopts no moved integration branch (ADR 0020).
The items of a pull request that reached the target by another method still complete, and the resolution names the commit that landed.
A fault on one part stops that part and every part above it: no retarget, and the fault waits on a person.
So the Operator writes nothing more to a pull request whose head a person moved (decision 21).
Only the person settles a fault, by an approval of action `stack-fault` whose target is the pull request and whose request revision is the reading that recorded the fault.
A settled merge by another method counts as landed, because its commits reached the target.
Any other settled fault ends its part, and the parts above a fault stay stopped, because their commits reach the target only through a new stack publication.

A defect found in an open published range, or a withdrawal of an item whose commit is in one, first recalls that range: with an approval, each open pull request from that part up becomes a draft, which cannot be merged, and gets one comment with the reason.
The correction or the take-out then runs on the local branch, and a new stack publication closes each recalled pull request with a pointer to its replacement.
A merged commit is never corrected or taken out; a defect found after the merge is new work.

The integration base changes only through a rebase that a person approves, before publish or after a recall or a stack fault.
The CLI gates the new base, then rebuilds the branch on it under the tests of the ADR 0020 rewrite, and a commit that already merged into the target leaves the branch.
A patch that the rebase changes becomes an integration cycle, and the new head needs a new branch review.
The preview reports whether the head merges cleanly onto the fetched target, as information, so a conflict with another source can be settled by this rebase before anyone reviews on GitHub.

A source is finished when every pull request of its last stack publication merged with a merge commit, or a person settled its merge by another method, and every tracker step of its items is verified.
Its gate checkout is removed then, by an unforced Herdr removal with no approval, so a checkout that holds a change stays, and Operator deletes no branch (ADR 0010).

## Considered options

The Operator agent pushing and opening the pull requests by hand, and the user doing it, were rejected.
A hand step leaves no record to recover from, and no command could refuse a publish that the branch review or the gate does not permit.

A merge by the CLI, behind a second approval, was rejected.
It takes the merge from the person who read the pull request, and on a team it asks the wrong person.
A push of the head to the target branch was rejected, because GitHub then marks the pull request merged even when its branch protection was not satisfied.

A rebase merge was rejected, because it gives every commit a new identity and, on a moved target, a tree that no gate run covers.
A squash merge was rejected, because the target then holds one commit for several results, and the higher pull requests of a stack keep commits that the target no longer holds.
Any merge method that the project allows was rejected for the same reasons.

The stacked pull requests of GitHub were rejected for now.
They are a preview, and after each merge they rebase the next pull request, which can rewrite a published commit.
They are the option to take again when they leave the preview and keep the commits of a merge commit.

A partial publish of the lower part of a stack was rejected.
ADR 0017 reviews the whole branch once, and a finding against a published part would need a new publication.

A plan revision that also covers the tip of the target branch was rejected.
Each merge by anyone to the target would then refuse a stack that did not change.

The tracker resolution at acceptance was rejected, because it names no final commit, a branch finding could reopen the ticket, and ADR 0016 would then refuse every production dependency across sources.
The resolution at publish was rejected, because a correction after publish still changes every commit, and a written comment is never corrected (ADR 0009).

A body that the Operator writes freely was rejected, because it repeats recorded facts that can drift.
A body with no written text was rejected, because where to start reading and the merge danger need judgment that no record holds.
Text that the Operator writes into the plan input was rejected, because the Operator writes no content of its own, and the branch reviewer is the one agent that read the whole head.

A next action that always offers the read while a pull request is open was rejected.
It is a loop that polls GitHub on every turn, and as an action that waits on a person it would hide every other wait (ADR 0011).
A readiness check of the merge settings was rejected, because readiness static checks read no network, and the plan already reads GitHub.

Signing at publish was rejected for now.
It gives every published commit an identity that differs from the reviewed head, and a signature that is not deterministic leaves recovery with no commit to expect.

A correction commit on top of a published branch was rejected, as ADR 0017 and ADR 0020 rejected it on the integration branch.
A correction with the published pull requests left open was rejected, because the defect stays one merge away while it is corrected.
Adopting a commit that a person pushed onto a published branch was rejected, because no result review read it.

A base that always follows the target at publish was rejected, because it gates every commit and reviews the branch again when nothing conflicts.

Deleting the remote branch of a merged part, so that GitHub changes the next base, was rejected, because Operator deletes no branch (ADR 0010).

## Consequences

A project that requires a linear history, or signed commits, cannot publish through Operator.

The trigger of the read after a merge is the user's word, which the Operator skill states, because no event reaches the crew when a pull request merges.

An accepted code result stays open on the tracker until its pull request merges, so a dependent in another source waits for that merge (ADR 0016).

A defect found after a merge, and an unwanted change that merged, are new work in a new item.

A source that must follow a moved target spends a gate run for each commit and a branch review, which counts against the limit of three (ADR 0017).

Each stack publication leaves its remote branches in place, and a person deletes them.
