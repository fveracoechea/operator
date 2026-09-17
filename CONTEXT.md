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
