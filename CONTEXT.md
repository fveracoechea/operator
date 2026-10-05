# Operator

Shared language for the Operator project's agent coordination workflow.

## Language

**Operator**:
The primary agent that is the user's main point of contact and coordinates the crew. Operator is also the project name; "the Operator" refers to the agent role.
The Operator writes no content of its own; it asks the crew or an Operative to make each change.
A ref move that the CLI builds only from reviewed patches, on a command that the Operator runs, is not an Operator change, and neither is the creation of an integration branch at a base that passed the project gate.
The take-out of a withdrawn commit is such a move, and it is bound to the revision of the registration plan whose approval recorded the withdrawal.

**Rules of the person**:
The five rules R1 to R5 that override a ticket, a resolution, an ADR, and a skill topic: the Operator is read-only, nothing merges a pull request without the explicit approval of the person, nothing tears down unlanded work, an Operative never addresses the person directly, and the Operator keeps its own context as low as possible.
The router of the `operator` skill states all five as a whole.
A conflict with one of them goes to the person, never to a choice of the Operator or the crew.

**Crew**:
The group of sub-agents coordinated by the Operator.

**Operative**:
A sub-agent assigned work by the Operator.
Operative is the preferred term; "Crew member" is an accepted alternative for the same role.

**Assignment**:
An approved unit of work with its inputs, dependencies, questions, and result. It persists across the loss or replacement of the crew process doing the work.

**Write path**:
A file or a folder, named from the repository root, that one assignment may change.
A folder covers everything under it, each path has one written form, and the letter case counts.
A path that an earlier release stored is read in that form, or it fails loudly.
Only a person widens the write paths of an assignment, with an approval; an answer never does.
The effective write paths are the registered paths plus every current grant, and the brief, submit, and the crew frontier read them.
_Avoid_: allowed paths, scope paths

**Attempt**:
One crew execution of an assignment, associated with its agent session and execution resources. A replacement crew process starts a new attempt on the same assignment.

**Result submission**:
The handoff of an assignment's result and supporting evidence for separate review. It is not accepted completion.

**Result review**:
The separate review of one result submission, which reads that result alone against the requirements it was produced against.
It is the review that accepted completion needs, and each submitted revision gets its own.
_Avoid_: per-assignment review

**Behavior change**:
A difference, compared with the base, in what changed code does for some input: an output, an error, a record that is dropped or skipped, or a boundary value that falls in another class.
Every result submission lists each one with its basis: the approved scope, one acceptance requirement, or one answered question whose answer is a requirement or a human answer. An empty list states that there is none.
An Operator decision is never a basis.
A change to a comment, a private name, or a test is not one.
_Avoid_: side effect, "no functional change"

**Outside change**:
A change found outside an Operative worktree between the launch of one attempt and its submission.
Its writer is not known, so it is never proof of a fault, and it is explained or removed before the result is accepted.
Only a person deletes one; the CLI proves the removal with a new scan.
_Avoid_: stray write, out-of-worktree write, violation

**Accepted completion**:
The Operator's acceptance of an assignment result after required review and every gate of acceptance are satisfied. It permits dependent assignments to use that result.
For a code result, the commit it lands as must first pass the project gate, and the integration branch must then hold the reviewed commit as the same patch.

**Operator decision**:
A decision made by the Operator within authority delegated by the user. It is distinct from a human answer, even when based on recorded human requirements.
A general delegation to decide from a named source does not make each decision a human answer: it makes that source an approved source, and a quote from it is a requirement.

**Human answer**:
A response given by the user to a question. An Operator inference or summary is not itself a human answer.

**Operator release**:
A matched version of the Operator CLI and Operator-owned skills, released together. Required upstream skills have separate revisions.
It carries its own record of the version, the commit, and the supported runtime, because a registry rewrites the package manifest of a published copy.

**Delivery path**:
How one project retrieves a release: the repository source at a full commit, or the registry artifact at an exact package version.
Both carry the same release from the same commit, and neither runs a build when it is retrieved.

**Release selection**:
The exact release one project coordinates with: its delivery path, its full commit, its package version where it has one, and the identity of the code and skills it names.
A missing or mismatched installation, and missing lock data, stop the work that reads it; they never permit another installation to stand in.

**Release artifact**:
The built contents of one release: runnable ESM, the public declarations, the complete owned-skill directories, the Herdr plugin, and the generated configuration schema.
It is identified by every byte it holds, so changed content is a different release.

**Release publication**:
The automatic delivery of one version, after its version pull request merges, from that merged commit, once the commit passed the quality gate and the release smoke.
Merging the version pull request is the decision to publish, and a push that carries a version both paths already hold publishes nothing.

**Delivery record**:
What one release has already delivered, path by path.
A retry reads it and carries the same artifact to the missing path only, because a published tag is never moved and a published version is never replaced.

**State version**:
The recorded format of the crew state.
A file an earlier release wrote is refused until an approved update migrates it behind a verified backup, and a file a newer release wrote is refused outright.

**Effective selection**:
The Operator and Crew host and model that a launch would use.
Each field is resolved on its own from the session override, then the project configuration, then the host default.
An unavailable explicit selection is an error, never permission to substitute.

**Configured**:
The state of a project whose approved setup plan is complete and whose selected files and settings validate.

**Ready**:
The state of a configured project whose required checks passed for its exact effective selection and evidence inputs.
Configured is not ready.

**Static check**:
A readiness observation of the current machine and project that needs no agent launch.
It is recomputed on every run and never claims that a live capability was proven.

**Live probe**:
A separately approved run of synthetic work through the selected hosts.
It proves what a static check cannot, such as host termination, the native review sub-agents, and provider compatibility.

**Probe plan**:
The declaration of what one live probe would use, made before anything launches.
It names the hosts and models, the provider use, the credentials, the fixture requirements, the temporary resources, the expected costs, and the cleanup.
It carries a revision, and an approval is bound to that revision.

**Probe fixture**:
The tracker repository and issue a live probe writes to instead of a project issue.
It is named in configuration, so a probe with none skips every tracker check.

**Probe attempt**:
One recorded run of the approved live checks.
Attempts are appended and never rewritten, so a failed attempt stays readable after a later one replaces what it proved.

**Probe observation**:
The durable record of one live check inside one attempt: its state, the versions and inputs it ran against, its outputs, its evidence, and the state of what it left behind.
A check that was attempted and could not run is skipped, which proves nothing, exactly like a failure.

**Readiness evidence**:
The recorded result of a live probe check, together with the fingerprints of the inputs it was proven against.
The result that stands for one check is the most recent attempt that ran it, and an attempt that never ran a check leaves the earlier result of it standing.
A changed input makes that record stale and leaves unrelated records valid.

**Claim**:
What recorded evidence is asked to support: readiness for this project, or a release.
Each live check names the claims it feeds, and a static check feeds every claim, so a check that is not proven holds back exactly the claims that read it.
A release also reads the readiness answer, so it is never provable on a project that is not ready.

**Crew state**:
The one local SQLite database that holds assignments, attempts, ownership, source revisions, fixed inputs, dependencies, permissions, and request records for a project.
It is created when an Operator first takes ownership, and it is never replaced by a command that cannot read it.

**Work source**:
The approved origin of registered work.
An approved specification, a ready ticket, and a wayfinder map are the three supported sources, each with its own revision.
Operator reads each one from the tracker, as a parent issue with its sub-issues or as one issue, and never creates the issues.
Its revision is the identity of the approved text of that parent issue or that one issue, so a comment or a closed ticket does not change it.
It is finished when every integrated pull request of its last stack publication merged with a merge commit, or a person settled its merge by another method, and every tracker step of its items is verified, or, when it has nothing to publish, when the rest of its work is accepted and its tracker steps are verified.

**Registration plan**:
The preview of what one registration would record, read from the tracker together with the Operator's input.
It carries a revision, and the registration refuses when a fresh read gives a different one, so an approval covers exactly what gets recorded.
Its full text is a local file named by that revision, and a command that reports it gives only a summary and the path.
On a new read of a registered source, it names each item as new, updated, or unchanged, and it records a new source revision or an updated item only under the person's approval of its revision.

**Integration branch**:
The one branch that collects the accepted commits of one work source, in the order they land.
It is a local branch named `operator/integration/<source slug>`, which the first code dispatch of the source creates at the integration base, and its name is recorded on the source.
No two sources share a slug, so no two sources share a branch.
Every later production dispatch of the source starts from its recorded tip, so a dependent assignment starts from it.
A branch that holds any other commit stops each production dispatch of its source, and only a person puts it back.
It moves only by a landing, by a rewrite that puts a corrected commit in place of the one it corrects or takes a withdrawn commit out, or by an approved rebase onto a new integration base, and only from the tip the crew last recorded.
Nothing pushes it before publish, and publish pushes its commits only under new remote names, so a pushed branch is never pushed again.
A published part of it is rewritten only after its pull requests are recalled, and a part that merged is never rewritten.
_Avoid_: autosquash, fixup, for the rewrite

**Integration base**:
The commit one integration branch starts from.
It changes only through a rebase onto a new base that a person approves, so a moved main branch never changes an accepted patch by itself, and a patch that the rebase changes is reviewed again.
The new base is a fetched tip of the target branch, it passes the project gate under the gate declaration fixed on the source before it is recorded, and the old base is below it.
A rebase runs before publish, or after a recall or a stack fault, and never while a published pull request of the source is open.
A commit whose pull request merged into the target leaves the branch, and a commit whose patch the rebase changes is taken out and comes back through an integration cycle.
It is fixed only after it passes the project gate, so a failure it already holds is never blamed on the first result.

**Landing**:
The move of an integration branch that adds one reviewed commit with its patch unchanged.
It is the last step of accepting that commit, after the commit it lands as passed the project gate, so the branch never holds a commit that failed another gate.
A commit whose parent is the tip lands as itself; any other lands as one new commit that copies its author, committer, dates, and message, so every plan of it names the same commit.
A commit whose equal patch the branch already holds lands nothing.
_Avoid_: integrate, cherry-pick, merge, for this act

**Project gate**:
The ordered commands that one project declares in a committed file, and that every commit of an integration branch, and its base, must pass before anything starts from it.
It is read at the integration base and fixed with it, so no result chooses the gate that scores it.
_Avoid_: quality gate, for this declaration; per-commit CI

**Gate run**:
One run of the project gate on one tree, recorded with its outcome for each command.
Runs are appended and never rewritten, and a tree passes only with a passing run and no failed one; a failure followed by a pass is flaky, and it blocks.
A reported pass from an Operative or a reviewer is not a gate run.
_Avoid_: spare worktree, rerun, for a fresh series that a person approves

**Gate checkout**:
The one checkout of a source in which its gate runs.
Herdr creates it once on its own branch, and its HEAD is detached at each key, so it never commits, never moves a branch, and holds no work.
_Avoid_: spare worktree

**Integrated pull request**:
A pull request that carries a contiguous range of one integration branch, with one commit for each accepted code result.
Operator opens it with a body rendered from the records and the published text, and a person merges it with a merge commit, so each of its commits reaches the target branch as it was reviewed and gated.
The Operator and the crew never merge it and never turn on auto-merge; a merge by a teammate of the person counts as the approval of the person.
_Avoid_: pull request per assignment

**Published text**:
The title, the summary, where to start reading, and the merge danger of each integrated pull request, and each cut point with its reason, which the branch reviewer writes in its report, or the result reviewer for a work source with one code commit.
The Operator only passes it on, and the publish approval binds it word for word.
_Avoid_: Operator sections, PR description

**Pull request stack**:
The ordered integrated pull requests of one work source, each based on the one below it.
A stack of one is the default.
It is published at once and merged from the bottom up, and after each merge commit the CLI changes the base of the next one to the target branch.
_Avoid_: delivery group

**Cut point**:
The place between two neighbouring commits of the integration branch where one integrated pull request of a pull request stack ends and the next one starts.
The branch reviewer proposes each one with a reason, and the person approves it in the publish approval.
_Avoid_: split, delivery group boundary

**Stack publication**:
One numbered push and opening of the pull request stack of one work source, at one reviewed head, with the cut points, titles, bodies, and tracker steps after the merge that one approval covers.
A work source can have several, because a change to a published range needs a new one and a pushed branch is never pushed again.
_Avoid_: release publication, and "publication" alone, for this act

**Recall**:
The return of the open integrated pull requests of one stack publication, from one part up, to drafts, before a correction or a withdrawal changes that range.
It keeps the change off the target branch while it is made, and the next stack publication closes what it recalled.
Its one comment on each pull request is rendered from the defect or the withdrawal record, and one approval binds the recall plan revision that names every comment.
When every code item above the recalled point is withdrawn, no publication follows, so the recall also closes what it recalled.
A merge before the recall ends the change: when a person settles that stack fault, the invalidation closes with no correction, and the merged result counts as landed.
_Avoid_: withdraw, retract, for this act

**Stack fault**:
An outcome on GitHub that no stack publication planned: a merge that is not a merge commit, a merge into another base, a commit that no review read on a pushed branch, a close with no merge, or a merge of a part that held a commit to change before its recall.
Operator adopts nothing from it, and it waits on a person.
A fault on one part stops every part above it.
Only the person settles it, by an approval of the reading: a settled merge by another method counts as landed, and any other settled fault ends its part.
Operator writes nothing more to a pull request whose head a person moved, also after the person settled that fault: a later stack publication only names it.
`operator publish status` records it when the user reports a merge or a close, because `operator crew next` never reads GitHub.
The items of a pull request that reached the target by another merge method still complete.
_Avoid_: delivery fault

**Branch snapshot**:
The recorded integration branch of one work source at one head: its base, its head, and its ordered commits with the accepted result of each.
It is what a branch review reads, and a different head, or a different accepted result of one commit, is a different snapshot.
_Avoid_: branch state

**Branch review**:
The review of one branch snapshot as a whole, which looks for what no result review can see: a relation between commits, and the coverage of the work source as a whole.
It gates the publish of that exact head, not the acceptance of any assignment.
_Avoid_: integration review, final review, whole-branch review, and "branch review" for the review of an Operative branch

**Planning boundary**:
The recorded statement of whether an assignment is executable or planning only.
Planning-only work is registered so dependencies resolve, and it is never dispatched to an Operative.
A sub-agent of the crew that prepares its planning record works for the Operator and holds no assignment, so preparing the record is not a dispatch.

**Planning record**:
What the Operator records when it accepts planning work: each decision with the question as it was asked, its answer authority, the exact words, and the reading of them, and the longer texts that the decision names.
The crew prepares it, and the prose of a decision is one of its text artifacts, never free text of the Operator.
Each direct dependent receives it in its brief, and the resolution on the tracker is a rendering of it.
It is fixed once it is accepted, so a changed decision invalidates the planning work.
_Avoid_: decision record, Decision section

**Next actions**:
The ordered list of what one crew may do now, with the waits that hold the rest.
It is one read that changes nothing, and it is the only schedule, so a session keeps no queue beside it.
An action that names a blocker waits on a person; a standing precondition is reported first and never decides whether the crew can advance.

**Wake binding**:
The association between one crew owner, one Operator agent session, and the attempts it was waiting for when it yielded.
It permits one wake prompt after a fresh next-actions read needs the Operator's attention.

**Attempt adoption**:
A new Operator's statement that it read what one inherited attempt holds.
It transfers who may act on the attempt and changes nothing about the work, so it needs settled effects and a running Operative.

**Crew frontier**:
The assignments a crew may start now, with the reason every other assignment waits.
It is a read that changes nothing.
It never offers an assignment that has not started whose write paths overlap the paths that unaccepted work of the same work source holds, and it offers no production work of a work source whose integration branch still holds a withdrawn commit.
_Avoid_: phase, partial dependency, file lock

**Ownership token**:
The value that proves a mutation comes from the Operator that currently owns the crew.
A takeover replaces it, and the replaced token can no longer change crew state.

**Request identity**:
The caller's name for one mutation.
A repeat under the same identity returns the recorded outcome of a mutation that changed state, with no new effect.
A mutation that changed nothing records nothing, so a repeat of a refused request is checked again against the current state.
The same identity carrying different input is refused once that identity has recorded an outcome.

**Assignment kind**:
The recorded class of one assignment, which fixes both its planning boundary and its dispatch priority.
Production work and review work are executable, and review work is offered first.
Planning work is not executable, so it carries no kind of its own beyond the planning boundary.

**Dispatch**:
The staged launch of one claimed assignment into an isolated Operative worktree.
It fixes the plan first, then records the intent and outcome of each external effect.
The plan also records the ids of the planning records that its brief carries.

**Launch snapshot**:
The effective crew host, model, Operator release, lock data, and skill contents that one attempt was launched with.
Recovery restores this record, never the current default.

**Brief**:
The fixed text one attempt is launched with: its identity, scope, acceptance requirements, authority limits, fixed inputs, the planning records of the planning work it depends on, the rework cycle it answers, if any, and the reporting protocol of its role.
It is the contract of the attempt, and the Operator never writes into it; a rework cycle carries the Operator's recorded dispositions and conflicts, never an instruction of its own.
_Avoid_: prompt, which only points to the brief

**Project instructions**:
The committed instruction files of one project, which a host loads by its own mechanism.
They carry the project's rules for the crew and for the reviewer, and the base commit of a launch fixes them.
The project gate is not a project instruction, because Operator runs it.
A personal instruction file is not a project instruction.
_Avoid_: shared rule block, common brief

**External operation**:
One recorded effect outside the crew state, with its own identity.
It is intended, succeeded, failed, or uncertain, and an uncertain one blocks its attempt until it is reconciled.

**Acknowledgement**:
The Operative's own report that it received its brief or an answer.
Herdr acknowledges a submission, not a turn, so this is the only proof that the submission arrived.

**Blocked report**:
The Operative's statement that it cannot continue, with the question, its evidence, its options, the recommendation, the scope that waits, and the work that continues without the answer.
It carries no authority of its own.
A tool that the Claude Code host of an Operative refuses becomes a blocked report, because that host never asks the person.

**Question revision**:
The recorded number of one question as asked.
It moves when the question or its target changes, which makes an answer recorded for the earlier revision inapplicable.

**Answer authority**:
Which of a requirement, a human answer, or an Operator decision stands behind one answer or one planning decision.
The exact words are recorded apart from the structured interpretation of them.
A requirement quotes a stored copy of its source, and its words must appear in that copy.
A decision of a grilling or a prototype never has an Operator decision behind it, because it is the user's side of a decision.

**Escalation trigger**:
A subject a question names that is outside delegated authority: visible behavior, scope, security permissions, unresolved ambiguity, or conflicting explicit requirements.
The Operative declares what it sees in its blocked report, and the Operator records what it sees separately.
A question that names one refuses an Operator decision, and conflicting requirements and unresolved ambiguity refuse a recorded requirement as well.

**Approval**:
A person's permission for one action, its targets, its scope, and the revision of the request it was granted against.
Silence, a timeout, a general direction to finish, and an Operative report are not approvals.

**Applicability check**:
The test of whether an answer recorded for an earlier question revision still answers the question now asked.
It precedes the approval that permits that answer to be used again.

**Control reference**:
The file in an Operative worktree that names the controlling checkout, assignment, and attempt.
The CLI reads it when an Operative reports, instead of searching nearby directories for crew state.
The Operative never opens it: the brief and the CLI results carry every fact it holds.

**CLI output**:
A file that a CLI result names by path, such as a registration, publish, or rebase plan file.
An agent reads it as part of that result.
It is not Operator-owned state, and the agent never changes it.

**Axis report**:
One half of a result review or a branch review, written by one native sub-agent of the reviewer host.
The Standards axis and the Spec axis stay separate and are never merged or reranked.

**Finding disposition**:
The Operator's answer to one review finding.
It is corrected, rejected with a reason and the evidence that refutes the finding, or deferred with a reason and a follow-up reference, so no finding leaves a review unanswered.

**Rework cycle**:
One delegated correction round on one submitted result, or on an accepted result that was invalidated.
It carries the accepted findings or the defect, the conflicts it must settle, the revisions it combines, and what was recorded in the earlier rounds of the assignment, and a fresh Operative answers all of them in one combined revision.
A fresh Operative is a new attempt, in a new agent session and a new checkout.
An integration cycle applies a result again, on the commit it lands on, when that result no longer lands with its reviewed patch or no longer passes the project gate there.
It combines only the submitted commit and the commit it lands on, which the CLI reads from the landing plan, and it carries a failed gate run as a fixed artifact.
The reviewer that found the problem, the Operator that disposed of it, and the Operative that produced the result are never its writer.
_Avoid_: send-back, same agent

**Direction request**:
The recorded statement that one assignment, or the branch review of one work source, reached a limit and now waits on the user.
It keeps the evidence of what was tried, blocks acceptance, or the dispatch of a branch review, while it is open, and is passed only by an approval that names the assignment and the revision of the request it answers.

**Invalidated result**:
An accepted result a defect was found in afterwards.
Its acceptance and evidence stay recorded, and only the dependents that consumed it, and the later results that the rewrite of its correction takes out, are paused.
A result is taken out when its patch changes, it fails the project gate at its new place, or a result it depends on is taken out; it returns to awaiting review, and its acceptance lands it again on the tip.
A paused result is not itself invalidated, because nothing was found wrong in it.
Its correction is a rework cycle that counts against the same limit as every other correction of that assignment, and it starts at the commit on the integration branch that carries the result.

**Withdrawal**:
The end of one registered assignment that a person took out of its work source, by removing its issue from the parent issue.
It is recorded behind the approval of a registration plan, only when no attempt of it is running and each dependent is withdrawn with it or no longer depends on it.
A withdrawn assignment never unblocks a dependent, and its history stays.
It records the registration plan revision whose approval recorded it.
A commit of it that the integration branch holds is taken out of that branch, bound to that plan revision, and until then no production work of its work source starts.
_Avoid_: cancel, drop, descope, abandon, revert, for this act

**Review capability**:
The reviewer host's ability to run the required review sub-agents.
An unavailable capability is a recorded blocker, never permission for a single-context self-review.

**Attempt replacement**:
A new attempt on the same assignment, started after the former writer is proven stopped and its partial work is inspected.
It keeps the inspected checkout and branch.

**Tracker binding**:
The tracker, the repository, and the issue one assignment was registered from.
An issue number alone does not name an item, because a sub-issue can live in another repository.
It is fixed at registration, so a later configuration change cannot redirect work that already exists.

**Tracker location**:
Where one work source lives in its tracker: its repository and its parent issue, if it has one.
Each tracker binding names its own repository.
The source location gives the parent and map issue.

**Tracker step**:
One of the three outcomes of completing work on a tracker: the recorded resolution, the ticket completion, and the map amendment.
Each one has its own intent, evidence, outcome, and recovery action.
For a code result, the three run only after the recorded merge of the pull request that carries its commit into the target branch, under the publish approval that named them, and its resolution is a rendering of the records with no free body.
Its map amendment keeps its stated input, and it also waits for a `map-amendment` approval that binds the exact text the CLI rendered after the merge.

**Logical operation**:
The name of one intended tracker effect, fixed before the first write and kept through every recovery attempt.
A comment carries it in a marker, which is a lookup convention and not proof that the comment was created exactly once.

**Write attempt**:
One record of sending the write of one logical operation.
A human-approved additional write adds an attempt and leaves the logical operation unchanged.

**Scan coverage**:
What one reading of a tracker actually covered.
An incomplete scan is a gap in the evidence, never evidence that something is absent.

**Canonical map**:
A wayfinder map read as its baseline body plus every explicit amendment comment.
An ordinary discussion comment is not an amendment, and the baseline body is never replaced automatically.

**Cleanup outcome**:
One recorded disposal step for one attempt: process closure or worktree removal.
The two are separate records, so each one blocks, fails, and recovers without the other.

**Process closure**:
The end of one Operative process after its work is durably handed over.
It proves the handoff, the revisions, the evidence, the answered questions, the checkout contents, the identity of every resource, the accounted child tools, and the termination itself.
It never touches the checkout.

**Worktree removal**:
The disposal of one approved Herdr-managed checkout.
Accepted completion is not disposal authority, so it also needs a closed process, preserved evidence, a checkout that holds only the commit its handoff names, and an approval granted against these exact inputs.
When that commit is the accepted result of its assignment, the integration branch must still hold it at its recorded tip.
A checkout that holds a commit of a withdrawn assignment, or a commit that a later accepted result of the same assignment replaced, holds unlanded work, so it is refused, and only the person removes it.
_Avoid_: remote copy, pushed, for this proof

**Cleanup request revision**:
The recorded name of the inputs one cleanup would act on.
It covers the registered work, the Operator that owns the crew, the resources named, and the checkout as it was inspected, so an approval survives a restart and nothing else.

**Preserved evidence**:
The inventory one cleanup copies out of an Operative worktree and verifies by content.
The list is explicit and holds no credential, and the copies stay readable after the checkout is gone.

**Retention hold**:
An explicit decision to keep one Operative's resources.
It blocks every cleanup of its attempt until a person releases it, and it outlives the session that placed it.

## Herdr language

These terms follow [Herdr's concepts](https://herdr.dev/docs/concepts/).

**Herdr workspace**:
A top-level project container that owns tabs and panes.
Operator groups an Operative's worktree workspace with the Operator's current workspace, but neither workspace is the checkout itself.

**Herdr worktree workspace**:
A separate Herdr workspace opened for a Git worktree checkout and grouped with its parent workspace.
The Operative runs in its own worktree workspace, not in a tab or pane of the parent.

**Herdr tab**:
A layout of panes inside a Herdr workspace.
It groups terminal views without creating another workspace.

**Herdr pane**:
A terminal inside a tab that holds a real process and persists when a client detaches.
An Operator or Operative agent can run in one pane.

**Herdr agent**:
An agent process that Herdr recognizes inside a pane.
This is the process Herdr observes, not an Operator assignment or attempt.

**Herdr agent state**:
Herdr's observation of an agent as `blocked`, `working`, `done`, `idle`, or `unknown`.
`done` means a completion has not been seen, while `idle` means it has been seen or the agent is waiting; each client tracks which completions it has displayed, so its badge can differ from the server's state.

**Herdr session**:
A persistent server namespace that owns its own panes, sockets, and runtime state.
It is distinct from an agent session.

**Agent session**:
One Operator or Operative agent's conversation with its host.
It is distinct from the Herdr session that runs its pane.

**Herdr server**:
The background process that owns Herdr panes and their running processes, even when no client is attached.

**Herdr client**:
A terminal UI attached to a Herdr server.
The client can detach without stopping the server or its agents.
