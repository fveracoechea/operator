# A source delivers one integration branch as a pull request stack

One work source delivers its code through one integration branch.
The branch collects one commit for each accepted code result, in the order the commits land.
A dependent assignment starts from the integration branch, so its base holds every result it depends on.

A code result is exactly one commit whose parent is the base commit of its dispatch.
`operator attempt submit` refuses a result with no commit, with more than one commit, or with a different parent.
The submission names no pull request.
The reviewer therefore reads the exact commit that lands, with the message that its Operative wrote.

Accepted completion of a code result means that the integration branch holds the reviewed commit as the same patch, that the commit it lands as passed the project gate first (ADR 0021), and that every gate of ADR 0007 passes.
The patch identity is compared, not the commit identity, because integration can move a commit to a new base with no change to its patch.
A patch that changed during integration, for example through a conflict resolution, is not the reviewed result, and acceptance refuses it.
This comparison replaces the pull request head check that ADR 0007 first recorded.

The commit order is the landing order.
A commit lands only after the results it depends on are accepted, so the landing order is a valid dependency order by construction.
Nothing is reordered after review.

The integration branch is published as a pull request stack.
A cut point between two neighbouring commits starts a new integrated pull request, which is based on the one below it.
A stack of one pull request is the default.
At publish, the branch reviewer proposes the cut points with a reason for each in its report, because it read the whole head and the Operator writes no content of its own (ADR 0022), and the user approves them as part of the publish approval.
An intent the user stated at registration is input to that proposal, not a fixed split.

A source with one code assignment delivers one pull request with one commit, so a pull request for each assignment is one case of this shape and not a second shape.

## Considered options

A pull request for each assignment, kept beside the integrated shape as an option of each source or each project, was rejected.
Two delivery shapes need two sets of acceptance gates and two brief texts, and two update paths drift.

Any number of commits in a result, squashed at integration, was rejected.
The writer of the squash, not the Operative, would then write the commit message, and the reviewer would not read the commit that lands.

Acceptance as review only, with a separate integrated state that the frontier reads, was rejected.
Every dependent would then read a second gate, and accepted completion would no longer mean that a dependent may use the result.

A dependent that starts from the reviewed commit of its dependency, as a stack of Operative branches, was rejected.
Those branches can still change during integration.

Commits in registration order were rejected.
Work that finishes out of order would be rebased after acceptance, and a conflict in that rebase changes a patch that was already accepted.

One integration branch for each delivery group, with the groups named at registration, was rejected.
Each group boundary is a barrier where parallel work stops, and the real size of the work is known only after it is done.

Cut points from a size limit were rejected.
No one limit fits every project, and a cut by count can fall inside one topic.

## Consequences

A cut can only fall between neighbouring commits, so an integrated pull request holds a contiguous range of the landing order, not a free choice of topic.

A user who wants a separate pull request for each ticket registers each ticket as its own source.

The commit order can differ from the issue order, so the pull request body lists the real order.

The migration to this shape refuses a crew state file that holds a code submission still waiting for review or acceptance, and it names each one.
The user finishes that work under the earlier release first.
An accepted submission keeps its recorded pull request as history.

The branch moves only as the last step of acceptance, so it never holds a commit that failed another gate, as ADR 0020 records.
ADR 0022 records how each pull request of a stack is opened, linked, and merged: by the CLI, with a merge commit, from the bottom up.
