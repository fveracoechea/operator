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

**Readiness evidence**:
The recorded result of a live probe check, together with the fingerprints of the inputs it was proven against.
A changed input makes that record stale and leaves unrelated records valid.

**Crew state**:
The one local SQLite database that holds assignments, attempts, ownership, source revisions, fixed inputs, dependencies, permissions, and request records for a project.
It is created when an Operator first takes ownership, and it is never replaced by a command that cannot read it.

**Work source**:
The approved origin of registered work.
An approved specification, a ready ticket, and a wayfinder map are the three supported sources, each with its own revision.

**Planning boundary**:
The recorded statement of whether an assignment is executable or planning only.
Planning-only work is registered so dependencies resolve, and it is never dispatched to an Operative.

**Crew frontier**:
The assignments a crew may start now, with the reason every other assignment waits.
It is a read that changes nothing.

**Ownership token**:
The value that proves a mutation comes from the Operator that currently owns the crew.
A takeover replaces it, and the replaced token can no longer change crew state.

**Request identity**:
The caller's name for one mutation.
A repeat under the same identity returns the recorded outcome with no new effect, and the same identity carrying different input is refused.
