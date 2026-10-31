# Operator

Shared language for Operator's declarative and deterministic agent coordination workflow.
The CLI owns the workflow state machines, performs the mechanical steps, and gives agents and subagents the applicable next actions.
These definitions describe the implemented design.

## Roles and authority

**Operator**:
This repository and its personal agentic tooling, not an agent role.

**SuperAgent**:
The supervising agent that manages WorkerAgents and is the person's point of contact.
It delegates detailed work, reads short reports, and opens details only when a coordination decision needs them.
_Avoid_: Operator as a role, Super Agent

**WorkerAgent**:
An agent that a SuperAgent gives work to and that reports to that SuperAgent, not directly to the person.
Implementation, review, reading, investigation, research, triage, planning, and prototyping are tasks, not separate roles or a closed list.
_Avoid_: Operative, Crew member, Agent as a role

**Rules of the person**:
The five rules that require delegation by SuperAgents, the PR merge gate, preservation of unlanded work, reporting through the supervising SuperAgent, and minimum SuperAgent context usage.
They permit coordination commands and communication between SuperAgents through Herdr without transferring the workers' tasks to a supervisor.

**SuperAgent decision**:
A decision within the authority that the assignment instructions delegate to a SuperAgent.
Neither report acceptance nor an inference makes it a human answer.

**Human answer**:
A response that the person gives to a question.
A SuperAgent's answer, interpretation, or acceptance is not a human answer.

**Grilling authority**:
The assignment instructions' statement of who answers questions and what the SuperAgent may decide.
Explicit human participation, a question outside that authority, or unclear authority requires the SuperAgent to ask the person.

## Device and projects

**Operator home**:
The two device folders that hold Operator settings and state for all registered projects.
Operator keeps no coordination files in project checkouts or worktrees.
_Avoid_: project-local Operator folder

**Device settings**:
Settings shared by all projects on a device, including hosts, models, effort, named start profiles, and review policy.
Externally managed read-only settings remain under their owner's control.
_Avoid_: project configuration

**Operator state**:
The device's durable workflow records for all registered projects, sources, assignments, launches, reports, and review requests.
_Avoid_: Crew state

**Registered project**:
A repository explicitly registered on the device by its GitHub owner and repository, with one controlling checkout.
Two clones of that repository are one project, and removing its registration deletes its Operator history without touching a checkout.
_Avoid_: setup for registration

**Controlling checkout**:
The one main, non-bare clone recorded for a registered project and used to locate its Herdr workspace.
It can move to another clone of the same repository only when the project has no open work source.

**Configured**:
A registered project whose controlling checkout exists, whose remote matches its identity, and whose device settings validate.
Its checkout has no legacy project-local Operator folder.

**Ready**:
The result of the current static readiness checks, not proof that an agent or provider will work.
Required tools, GitHub authentication, required skill contents, and the commit hook on Claude Code must pass those checks.

**Static readiness check**:
A current observation of required executable availability, GitHub authentication, required skill files, or the commit hook entry in Claude Code settings.
It launches no agent and retains no live-probe evidence.

**Commit hook**:
Operator's Claude Code hook, `operator claude hook`, which denies a `git commit` whose message carries a Co-Authored-By trailer.
It never allows a tool. `operator install --claude` adds it to the person's Claude Code user settings.
_Avoid_: permission rule, attribution setting

**Operator release**:
One matched version of the CLI, its owned skills, and its shipped database migrations.
The running installation is the device's release authority, while upstream skills keep independent revisions.

**Delivery path**:
One of the three ways to obtain the same release, JSR installed globally with Bun, a Nix flake, or repository source at a full commit.

**Release artifact**:
The content-identified CLI, public declarations, owned skills, plugin content, schemas, and fixed migrations that belong to one release.
All delivery paths preserve that release's commit, and JSR and Nix also preserve its artifact identity.

**Release publication**:
Automatic delivery from a merged version change after its quality checks and release smoke pass.
A published tag or version is immutable.

**Delivery record**:
The record of where an immutable release has already been published.
A retry supplies only missing delivery without replacing published content.

**State version**:
The compatibility history of Operator state.
It identifies the recorded format that a release can read.

**Start profile**:
A named, extensible set of launch settings selected for an assignment.
It can override device host, model, and effort defaults without defining a separate worker role.

**Effective selection**:
The resolved host, model, and effort for a launch, including its selected profile and applicable overrides.
An unsupported explicit selection is an error, not permission to substitute another.

**Launch snapshot**:
The recorded host, model, effort, Operator release, and skill identities of one worker launch.
A running worker keeps that selection, while a replacement uses the settings resolved for its new launch.

## Delegated work

**Work source**:
A registered plan of assignments, dependencies, and tracker keys supplied by a SuperAgent, not read from a tracker by the CLI.
Each registration has a new identity, and a source is ended when it is finished or reset.

**Assignment**:
One independently scheduled unit of delegated work with a brief, dependencies, a start profile, resource needs, and an explicit PR or report completion type.
Native subagents remain within their parent WorkerAgent's assignment unless their work needs independent scheduling or acceptance.

**Completion type**:
The assignment's choice of PR merge or accepted report as its completion contract.
It determines lifecycle and dependency rules, not the set of tasks a WorkerAgent may do.

**PR assignment**:
An assignment whose owner WorkerAgent carries one pull request through review, feedback, CI, and merge.
A dependent can start when the dependency's PR is open or merged.
It stacks on the branch of one open parent PR, and it waits while more than one parent PR is open.

**Report assignment**:
An assignment that completes through SuperAgent acceptance of a durable report rather than a PR.
Its dependents wait for that acceptance, and read-only report work needs no branch or worktree.

**Ready assignments**:
Assignments whose recorded state and completion-type-specific dependency rules permit dispatch.
_Avoid_: Crew frontier

**Brief**:
The device-state task instructions supplied to a WorkerAgent by an absolute reference at launch.
It identifies the assignment's task, skills, resources, result locations, and reporting contract, with earlier reports and follow-up instructions for a replacement.

**Dispatch**:
The CLI's launch of a WorkerAgent through Herdr with a resolved start profile and a brief from the running release's template.
An assignment that changes project files uses an isolated worktree, while read-only work can use a project-workspace pane.

**Report**:
A durable worker submission with a short conclusion, evidence references, unresolved points, and detailed supporting files available by reference.
It awaits SuperAgent acceptance and is not proven by host activity or a Herdr completion event.

**Completion**:
The verified merge of a PR assignment or the SuperAgent's acceptance of a report assignment.
Submission alone is not completion.

**Follow-up**:
Specific instructions that a SuperAgent returns with a report that it has not accepted.
The worker resumes the assignment with those instructions and the prior reports available.

**Next actions**:
The CLI's applicable actions and waits derived from recorded workflow state and observed facts.
They include ready work, PR actions, reports awaiting acceptance, interrupted workers, failed cleanup, and ended sources, without a second agent-maintained schedule.

**PR feedback loop**:
The owner WorkerAgent's repeated response to new reviews, comments, failing CI, or a merged parent PR through the CLI's wait operation.
It retains the owner's working context rather than requiring a fresh writer for every correction.

**PR merge gate**:
The conditions that the CLI checks before it merges a PR.
They require approval, passing checks, no unresolved review threads, a default-branch base, a PR that is not a draft, and an internal review that ended ready or was skipped.
_Avoid_: project gate

**Internal review**:
The unpublished review of a draft PR by a fresh WorkerAgent that takes over the PR assignment from its implementer.
The reviewer applies the valid findings, moves the PR to ready with one summary comment, and then owns the PR to its merge.
It is on by default, and an assignment, a plan, or the device setting can turn it off.
_Avoid_: self-review, pre-PR review, internal review request

**Internal review round**:
One review of the whole PR diff against its base at a recorded head, followed by the fixes for its valid findings.
An internal review has at most two rounds.

**Source reset**:
The end of one work source on the person's instruction, with merged PR assignments and completed reports preserved and incomplete assignments abandoned.
It refuses while a worker is running and removes no worktree, branch, or tracker content.

**Source prune**:
Deletion of an ended source's Operator records and device-state files once at least 14 days have passed since its end.
It creates no archive and removes no retained worktree or branch.

**Unlanded work**:
Project work whose safe disposal the CLI cannot establish through completion evidence and inspection.
Only the person can authorize its deletion.

**Cleanup**:
The CLI's disposal of resources after verified completion, with failures kept visible in next actions.
PR merge permits remote-branch deletion, pane closure, and worktree removal, while report acceptance permits pane closure but not deletion of unlanded work.

**Canonical map**:
A wayfinder map's baseline body plus every explicit amendment comment.
It is a planning convention for agents, not a CLI tracker state machine.

## Review requests

**Review request**:
A separate record for review rounds on one PR, originating from Slack or the optional reviewer of a PR assignment.
It is not an assignment and does not wait for merge to deliver a review.
An internal review is not a review request.
_Avoid_: Slack review, PR review job

**Review round**:
One review of a request's recorded head and open threads, triggered by the first request, new commits, author activity, or a renewed request.
It records the draft's event and posted review, with earlier rounds available to the reviewer.

**Review draft**:
The reviewer's structured findings, thread replies, reviewed commit, and reported check outcomes before any post.
The CLI validates it, checks the PR head and CI, computes the event, and posts it.

**Author policy**:
Device settings that select registered repositories and GitHub authors eligible for review requests.
A skip applies to one PR, never to all PRs of an author.

**Slack effect**:
A CLI-generated reply or reaction that an agent transports through Slack MCP tools and acknowledges to the CLI.
Its pending or completed record permits a session to resume without an agent-written ledger.

## Herdr language

**Herdr workspace**:
The project container that owns tabs and panes.
It is not a Git checkout.

**Herdr worktree workspace**:
A Herdr workspace for an isolated Git worktree, grouped with its project workspace.
Herdr chooses the worktree's location.

**Herdr tab**:
A layout of panes within a workspace.

**Herdr pane**:
A terminal with a real process that remains when a client detaches.

**Herdr agent**:
The runtime agent process that Herdr observes in a pane, not the workflow role or assignment.

**Herdr agent state**:
Herdr's observation of process activity.
It is not evidence that a report was submitted, accepted, or that a PR merged.

**Agent session**:
One SuperAgent or WorkerAgent conversation with its host, distinct from a Herdr session.

**Herdr session**:
A persistent server namespace with its own panes, sockets, and runtime state.

**Herdr server**:
The process that owns panes and their running processes when no client is attached.

**Herdr client**:
The terminal UI attached to a server, which can detach without stopping the agents.
