# Operator

Shared language for the Operator project's agent coordination workflow.

## Language

**Operator**:
The primary agent that is the user's main point of contact and coordinates the crew. Operator is also the project name; "the Operator" refers to the agent role.

**Crew**:
The group of sub-agents coordinated by the Operator.

**Operative**:
A sub-agent assigned work by the Operator.
Operative is the preferred term; "Crew member" is an accepted alternative for the same role.

**Assignment**:
An approved unit of work with its inputs, dependencies, questions, and result. It persists across the loss or replacement of the crew process doing the work.

**Attempt**:
One crew execution of an assignment, associated with its agent session and execution resources. A replacement crew process starts a new attempt on the same assignment.

**Result submission**:
The handoff of an assignment's result and supporting evidence for separate review. It is not accepted completion.

**Accepted completion**:
The Operator's acceptance of an assignment result after required review and quality gates are satisfied. It permits dependent assignments to use that result.

**Operator decision**:
A decision made by the Operator within authority delegated by the user. It is distinct from a human answer, even when based on recorded human requirements.

**Human answer**:
A response given by the user to a question. An Operator inference or summary is not itself a human answer.

**Operator release**:
A matched version of the Operator CLI and Operator-owned skills, released together. Required upstream skills have separate revisions.

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
The declaration of what one live probe would use before anything launches: the exact hosts and models, the provider use, the credentials each host and the fixture need, the temporary resources, the expected costs, and the cleanup.
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

**Crew state**:
The one local SQLite database that holds assignments, attempts, ownership, source revisions, fixed inputs, dependencies, permissions, and request records for a project.
It is created when an Operator first takes ownership, and it is never replaced by a command that cannot read it.

**Work source**:
The approved origin of registered work.
An approved specification, a ready ticket, and a wayfinder map are the three supported sources, each with its own revision.

**Planning boundary**:
The recorded statement of whether an assignment is executable or planning only.
Planning-only work is registered so dependencies resolve, and it is never dispatched to an Operative.

**Next actions**:
The ordered list of what one crew may do now, with the waits that hold the rest.
It is one read that changes nothing, and it is the only schedule, so a session keeps no queue beside it.
An action that names a blocker waits on a person; a standing precondition is reported first and never decides whether the crew can advance.

**Attempt adoption**:
A new Operator's statement that it read what one inherited attempt holds.
It transfers who may act on the attempt and changes nothing about the work, so it needs settled effects and a running Operative.

**Crew frontier**:
The assignments a crew may start now, with the reason every other assignment waits.
It is a read that changes nothing.

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

**Launch snapshot**:
The effective crew host, model, Operator release, lock data, and skill contents that one attempt was launched with.
Recovery restores this record, never the current default.

**External operation**:
One recorded effect outside the crew state, with its own identity.
It is intended, succeeded, failed, or uncertain, and an uncertain one blocks its attempt until it is reconciled.

**Acknowledgement**:
The Operative's own report that it received its brief or an answer.
Herdr acknowledges a submission, not a turn, so this is the only proof that the submission arrived.

**Blocked report**:
The Operative's statement that it cannot continue, with the question, its evidence, its options, the recommendation, the scope that waits, and the work that continues without the answer.
It carries no authority of its own.

**Question revision**:
The recorded number of one question as asked.
It moves when the question or its target changes, which makes an answer recorded for the earlier revision inapplicable.

**Answer authority**:
Which of a requirement, a human answer, or an Operator decision stands behind one answer.
The exact words are recorded apart from the structured interpretation of them.

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
An Operative reads it instead of searching nearby directories for crew state.

**Axis report**:
One half of a review, written by one native sub-agent of the reviewer host.
The Standards axis and the Spec axis stay separate and are never merged or reranked.

**Finding disposition**:
The Operator's answer to one review finding.
It is corrected, rejected with a reason and the evidence that refutes the finding, or deferred with a reason and a follow-up reference, so no finding leaves a review unanswered.

**Rework cycle**:
One delegated correction round on one submitted result.
It carries the accepted findings, the conflicts it must settle, and the revisions it combines, and a fresh Operative answers all of them in one combined revision.
The reviewer that found the problem and the Operator that disposed of it are never its writer.

**Direction request**:
The recorded statement that one assignment reached a limit and now waits on the user.
It keeps the evidence of what was tried, blocks acceptance while it is open, and is passed only by an approval that names the assignment and the revision of the request it answers.

**Invalidated result**:
An accepted result a defect was found in afterwards.
Its acceptance and evidence stay recorded, and only the dependents that consumed it are paused.

**Review capability**:
The reviewer host's ability to run the required review sub-agents.
An unavailable capability is a recorded blocker, never permission for a single-context self-review.

**Attempt replacement**:
A new attempt on the same assignment, started after the former writer is proven stopped and its partial work is inspected.
It keeps the inspected checkout and branch.

**Tracker binding**:
The tracker and the ticket one assignment was registered from.
It is fixed at registration, so a later configuration change cannot redirect work that already exists.

**Tracker location**:
Where one work source lives in its tracker: its repository and its map, if it has one.
An assignment reads its binding from the source it was registered under.

**Tracker step**:
One of the three outcomes of completing work on a tracker: the recorded resolution, the ticket completion, and the map amendment.
Each one has its own intent, evidence, outcome, and recovery action.

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
Accepted completion is not disposal authority, so it also needs a closed process, preserved evidence, a remote copy of every commit, and an approval granted against these exact inputs.

**Cleanup request revision**:
The recorded name of the inputs one cleanup would act on.
It covers the registered work, the Operator that owns the crew, the resources named, and the checkout as it was inspected, so an approval survives a restart and nothing else.

**Preserved evidence**:
The inventory one cleanup copies out of an Operative worktree and verifies by content.
The list is explicit and holds no credential, and the copies stay readable after the checkout is gone.

**Retention hold**:
An explicit decision to keep one Operative's resources.
It blocks every cleanup of its attempt until a person releases it, and it outlives the session that placed it.
