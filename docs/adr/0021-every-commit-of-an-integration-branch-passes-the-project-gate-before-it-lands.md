# Every commit of an integration branch passes the project gate before it lands

A result review reads one commit on the base of its own dispatch, and the checks of that result ran on that tree.
When other results land first, the commit lands on a tip that neither its producer nor its reviewer ever read, and a rewrite gives every later commit a tree that nobody ran a check on.
In a flow run by hand, the main agent ran the gate at every commit in a spare checkout, once after integration and again after the history changed, and one failure was found only that way.
The checks of a result are also chosen by its producer, so they can differ from commit to commit and cover only part of the project.

Each project declares one project gate: an ordered list of commands, each with a name, its arguments, and a time limit.
The declaration is a committed file of the project, `operator-gate.json` at the repository root.
It is read at the integration base, never from a working tree, and it is fixed on the source together with the base, so no result chooses the gate that scores it.
A result may change the file, and the change takes effect only for a later source.
A missing or invalid declaration refuses the first code dispatch of a source, and readiness reports it as a standing precondition.

A gate run is one run of the project gate on one tree.
Its key is the identity of that tree and the identity of the declaration, and the commit is recorded beside them.
The outcome depends only on those two inputs, so a signature or a new message on the same tree keeps its record.
Runs are appended and never rewritten.
A key passes only when it has a passing run and no failed run.
A failed run blocks, and a later passing run at the same key makes the key flaky, which also blocks, because a check that passes only sometimes proves nothing.
Nothing reruns a gate by itself.
Only a person can start a fresh series of runs at one key, with an approval that names the key and each failed run it answers, and those runs stay recorded.

The gate runs before the branch moves.
`operator work accept` plans the landing, and the planned commit is the candidate.
Acceptance refuses, and changes nothing, until the candidate key passes.
A rewrite gates each commit of the rebuilt range in order, and the branch moves once, after every commit of the final plan passed.
A later commit that fails in a rewrite is taken out with its dependents, in the same way as a later commit whose patch changed.
The integration base is gated before it is fixed, so a failure that the base already holds is never blamed on the first result.
So every commit of the branch, and its base, passed the gate before anything started from it, and publish only reads the records.

A failed candidate points to the result that is being accepted, because the base and every commit below it already passed.
The Operator answers it with an integration cycle, which starts from the commit the candidate lands on and carries the failed run as a fixed artifact.
The cycle counts against the correction limit of the assignment, so a failure that repeats reaches the user.

The CLI runs the gate, because an exit status that Operator code reads is a fact, and an agent that reports a pass makes a claim.
The run is asynchronous, because a gate can outlast the time that one call of an agent host may block.
Each source has one gate checkout, which Herdr creates and removes when the source is finished (ADR 0022).
Its HEAD is detached at each key, and every file that is not in the tree is removed before each run, so nothing outside the key can change an outcome.
An Operator runner in the pane starts each command with its arguments and no shell, reads each exit status from the process, and records each outcome with its output as a stored artifact.
The runner writes only while the owner that started the run still owns the crew.
A run with no recorded outcome proves nothing, and a new run replaces it once the pane shows that the former runner stopped.
The gate checkout never commits and never moves a branch, so the Operator still holds no worktree it writes in.

The producer and the reviewers also run the project gate.
The brief states each command beside the submit command, and submit refuses a code result whose recorded checks do not show each of them as passed, so the producer fixes a failure with its own context.
A branch review runs the project gate at its head, and publish refuses when that observation differs from the gate run at the head key.
Neither observation stands in for a gate run.

## Considered options

The recorded checks of each result as the gate were rejected.
Each producer chooses its own commands, so "each commit passes the gate" would mean something different at each commit.

The project gate as prose in the project instructions was rejected.
A command-line tool cannot run prose, and a rule that no check enforces is a suggestion.

The project gate in the Operator configuration was rejected.
That configuration is local to one checkout and nobody reviews it, so another checkout would gate with other commands, as ADR 0005 already found for the rules of a project.

The project gate in the input of each registration was rejected.
One project fact would then be typed again for every source, and two copies drift.

A gate after the landing, with dispatch held until it passes, was rejected.
The branch would then hold accepted commits that fail, and each failure would pause every consumer through invalidation, for a fault that a machine finds.

A gate before publish only was rejected.
Later work would start from a tip that fails, and the next producer would find a failure that its own change did not make.

A gate Operative, as review work with a narrow brief, was rejected.
It spends a crew slot and provider tokens on a step with no judgment, and its report is a claim.

A gate that the reviewer runs at each commit was rejected.
A reviewer that checks out other commits changes its own checkout, and its review is then refused.

A status file that a typed shell line writes was rejected.
The code under test can write the same file, and the text of a command typed into a shell can run a second command.

A gate that blocks inside one command until it ends was rejected.
It fails at the time limit of the agent host, and it holds the whole turn of the Operator.

A gate checkout for each run was rejected, because each Herdr checkout leaves a branch and Operator deletes no branch.
A gate checkout that keeps ignored files between runs was rejected, because a stale build output or cache can make a run pass.

A key made of the commit alone was rejected.
A signature at publish changes every commit and no tree, so every record would miss the published head.

The most recent run as the one that stands, as ADR 0012 records for readiness evidence, was rejected.
Readiness asks whether a capability exists, and the gate asks whether one tree is correct.
Two runs of every key were rejected, because they double the cost and still miss a flaky test that fails one run in ten.
A fresh series that the Operator starts on its own suspicion was rejected, because the party that wants the landing would decide that a failure did not count.

A reference that holds the candidate was rejected.
The landing plan gives the same candidate again, the checkout keeps it while the gate runs, and the record is keyed by the tree.

A reviewer observation at a fast-forward candidate in place of a gate run was rejected, because it is a claim.

## Consequences

Each landing on a moved tip waits for one gate run, and each run installs the project again from nothing.
One gate run of a source runs at a time, because two candidates on one tip can never both land, and the next actions offer a landing that waits before a new run of the same source.
A gate run takes no crew slot, because it starts no agent.

The gate runs code that an Operative wrote, with the environment and network of the user, and not inside the permissions of an agent host.
The write paths, the submit checks, and the result review come before it.

A result can still change what a gate command does, for example the body of a script that a command names, when its write paths cover that file.
The result review and the branch review read that change.

The key does not cover the machine, so a changed tool version outside the tree does not make a record stale.

A failed or flaky key at the base has no assignment to correct it, so only the user can clear it: by a fixed main branch and a new base, or by an approval of a fresh series.

A rebase of the branch onto a moved main branch, which a person approves (ADR 0022), gives every commit a new tree, so every commit is gated again before it is published.

Removal of the gate checkout needs no approval, because it holds no work, as ADR 0012 records for the checkout of a probe.
The branch that Herdr creates for it never moves and stays after the checkout is gone.

ADR 0005, 0007, 0008, 0015, 0017, 0018, and 0020 are amended to refer to this record.
